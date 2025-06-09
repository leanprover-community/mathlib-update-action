import core from "@actions/core";
import { Buffer } from "buffer";
import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import semver from "semver";
import TOML from "smol-toml";

/**
 * Get the Git tags of the specified repository that denote a Lean release.
 *
 * Note that some repositories, such as Mathlib, do not make GitHub releases for these Git tags,
 * so we use Git instead of GitHub to access this data.
 *
 * @param repo: repository in the OWNER/REPO format. Use null for the current project.
 */
function getVersionTags(repo) {
  var versionTags;
  if (repo !== null) {
    console.log(`Fetching tags from ${repo}`);
    const cmd = `git ls-remote --tags https://github.com/${repo}.git`;
    versionTags = execSync(cmd, { encoding: "utf8" })
      .split("\n")
      // Lines with a ^{} indicate an "annotated tag": these appear twice in the list of tags, once with and once without ^{}.
      .filter((line) => line !== null && !line.endsWith("^{}"))
      // Each line holds information on a tag, of the format '${commitHash} refs/tags/${tagName}'.
      // We want only the tags of the format `v${major}.${minor}(.${patch})`.
      .map((line) => {
        const match = line.match(/refs\/tags\/(v.*\..*)$/);
        if (match != null) {
          return match[1];
        } else {
          return null;
        }
      })
      .filter((tag) => tag !== null);
  } else {
    console.log(`Fetching release tags from current repository.`);
    // First ensure we have all the tags from the remote. Apparently the checkout action doesn't do this reliably.
    execSync("git fetch --tags");
    const cmd = `git tag --list 'v*.*'`;
    versionTags = execSync(cmd, { encoding: "utf8" })
      .split("\n")
      .filter((line) => line !== "");
  }

  // Parse version tags as semver (removing the 'v' prefix)
  const semvers = versionTags.map((ver) => {
    const parsed = semver.parse(ver.substring(1));
    parsed.original = ver;
    return parsed;
  });

  // Sort versions and get the latest one
  semvers.sort((a, b) => semver.compareBuild(a, b));

  return semvers;
}

function fileChanges(filename) {
  const diff = execSync(`git diff -w ${filename}`, { encoding: "utf8" });
  return diff.length > 0;
}

/**
 * Modify the project's `lakefile.lean` so it depends on Mathlib at the specified tag.
 */
function modifyLakefileLeanMathlibVersion(fd, tag) {
  throw new Error("Project uses `lakefile.lean`; this is not yet supported!");
}

/**
 * Modify the project's `lakefile.toml` so it depends on Mathlib at the specified tag.
 */
function modifyLakefileTOMLMathlibVersion(fd, tag) {
  const data = fs.readFileSync(fd, "utf8");
  const lakefile = TOML.parse(data);

  for (const pkg of lakefile.require) {
    if (pkg.scope == "leanprover-community" && pkg.name == "mathlib") {
      pkg.rev = tag;
    }
  }

  // Overwrite the file.
  // First truncate the file, to handle the case where the new file is shorter.
  fs.ftruncateSync(fd);
  // Explicitly set the writing position to 0, since it will have been moved by reading.
  const buffer = Buffer.from(TOML.stringify(lakefile), "utf8");
  fs.writeSync(fd, buffer, undefined, undefined, 0);
}

/**
 * Modify the project's Lakefile (`.lean` or `.toml`) so it depends on Mathlib at the specified tag.
 */
function modifyLakefileMathlibVersion(tag) {
  // Lake prefers `.lean` over `.toml` files.
  // So, we try opening the `.lean` file, but if that fails, we try again with the `.toml`.
  // Use try/catch instead of `if (fs.access('lakefile.lean'))` to avoid TOCTOU issues.
  try {
    const fd = fs.openSync("lakefile.lean", "r+");
    return modifyLakefileLeanMathlibVersion(fd, tag);
  } catch (error) {
    console.log(
      "Could not open `lakefile.lean`: trying again with `lakefile.toml`.",
    );
  }
  try {
    const fd = fs.openSync("lakefile.toml", "r+");
    return modifyLakefileTOMLMathlibVersion(fd, tag);
  } catch (error) {
    throw new Error(
      `Could not find \`lakefile.lean\` or \`lakefile.toml\`.\nNote: nested error: ${error}.\nHint: make sure the \`lake_package_directory\` input is set to a directory containing a lakefile.`,
    );
  }
}

/**
 * Run `lake update`.
 *
 * @param legacyUpdate If true, add the `-R -Kenv=dev` flags, corresponds with `legacy_update` action input.
 */
function lakeUpdate(legacyUpdate) {
  if (legacyUpdate) {
    console.log("Using legacy update command");
    execSync("lake -R -Kenv=dev update", { stdio: "inherit" });
  } else {
    console.log("Using standard update command");
    execSync("lake update", {
      stdio: "inherit",
      env:
        // We do not need to fetch the Mathlib cache on every step.
        Object.assign({ MATHLIB_NO_CACHE_ON_UPDATE: "1" }, process.env),
    });
  }
}

/**
 * Prepare the metadata file for subsequent jobs to build and commit/PR/create an issue.
 *
 * @param tag The tag (Git ref) on the Mathlib repository to update to.
 *
 * @return A boolean whether any changes to the metadata files were made.
 */
function prepareMetadata(tag) {
  const metadataFiles = ["lean-toolchain", "lake-manifest.json"];
  const toolchainChanges = fileChanges("lean-toolchain");
  const manifestChanges = fileChanges("lake-manifest.json");
  if (!metadataFiles.some(fileChanges)) {
    console.log("No changes to commit - skipping update.");
    return false;
  }

  // We will be storing our new toolchain and manifest here, for the subsequent workflow jobs to pick up.
  const destDir = path.join("mathlib-update-metadata", tag);
  fs.mkdirSync(destDir, { recursive: true });
  for (const metadataFile of metadataFiles) {
    fs.copyFileSync(metadataFile, path.join(destDir, metadataFile));
  }

  return true;
}

/**
 * Create a pull request for each new Lean release tag in Mathlib.
 */
try {
  const intermediateReleases = process.env.INTERMEDIATE_RELEASES;
  const legacyUpdate = process.env.LEGACY_UPDATE === "true";

  // Determine the releases to upgrade to.
  var newReleases = [];
  if (intermediateReleases === "all" || intermediateReleases === "latest") {
    const mathlibReleases = getVersionTags("leanprover-community/mathlib4");
    const ourReleases = getVersionTags(null);
    console.log(
      `Found ${mathlibReleases.length} Mathlib releases and ${ourReleases.length} project releases.`,
    );

    // If this project has no versions released yet, only upgrade to the latest Mathlib master.
    // Otherwise we'd get a PR upgrading to each Mathlib version in turn.
    // (If you install a `lean-release-action` workflow, the release tag should have been automatically created.)
    if (ourReleases.length > 0) {
      // If this project does have some releases already, do not skip any intermediate steps,
      // upgrade to each release in turn from the last one that we support.
      const latestVersion = ourReleases[ourReleases.length - 1];
      newReleases = mathlibReleases.filter((v) => semver.gt(v, latestVersion));

      // If we only want the latest release, drop all but the last element.
      // This can result in a 0-element array (no Mathlib releases newer than our latest version)
      // or a 1-element array (containing the latest Mathlib release).
      if (intermediateReleases === "latest") {
        newReleases = newReleases.slice(-1);
      }

      console.log(
        `Going to upgrade to the versions: ${JSON.stringify(newReleases)}, followed by 'master'.`,
      );
    } else {
      console.log(
        `No releases found in the current project; upgrading directly to 'master'. Hint: use the lean-release-action to automatically create releases when the toolchain is updated.`,
      );
    }
  } else if (intermediateReleases !== "master") {
    console.log(
      `Unsupported value for input 'intermediate_releases': got '${intermediateReleases}', expected 'all', 'latest' or 'master'.`,
    );
    process.exit(1);
  }

  // As a last step, always upgrade to the master branch.
  newReleases.push({ original: "master" });

  var newTags = [];
  for (const release of newReleases) {
    modifyLakefileMathlibVersion(release.original);
    lakeUpdate(legacyUpdate);
    if (prepareMetadata(release.original)) {
      newTags.push(release.original);
    }
  }

  // Output status to GitHub Actions.
  core.setOutput("new-tags", JSON.stringify(newTags));
  core.setOutput("is-update-available", newTags.length > 0);
} catch (error) {
  console.error("Error updating Lean version:", error.message);
  process.exit(1);
}
