# Automatic Mathlib update action.

A GitHub Action that attempts to update a Lean project depending on Mathlib.

This reuses code licensed under the MIT license from leanprover-community/lean-update by Asei Inouse(Seasawher), which in turn forks oliver-butterley/lean-update by Oliver Butterley.

## Installation

First make sure that GitHub Actions can create and approve pull requests: go to Settings -> Actions -> General and select "Allow GitHub Actions to create and approve pull requests".

Then, copy the following code into `.github/workflows/mathlib-release-update.lean`, commit and push it.

```yml
name: Update Dependencies
on:
  schedule:             # Sets a schedule to trigger the workflow
    - cron: "0 8 */7 * *" # Every 7 days at 08:00 AM UTC (for more info on the cron syntax see https://docs.github.com/en/actions/writing-workflows/choosing-when-your-workflow-runs/events-that-trigger-workflows#schedule)
    workflow_dispatch:    # Allows the workflow to be triggered manually via the GitHub interface

jobs:
  check-for-updates: # Determines which updates to apply.
    runs-on: ubuntu-latest
    outputs:
      is-update-available: ${{ steps.check-for-updates.outputs.is-update-available }}
      new-tags: ${{ steps.check-for-updates.outputs.new-tags }}
    steps:
      - name: Run the action
        id: check-for-updates
        uses: leanprover-community/mathlib-update-action@main
        with:
          # START CONFIGURATION BLOCK 1
          intermediate_releases: all
          # END CONFIGURATION BLOCK 1
  do-update: # Runs the upgrade, tests it, and makes a PR/issue/commit.
    runs-on: ubuntu-latest
    permissions:
      contents: write      # Grants permission to push changes to the repository
      issues: write        # Grants permission to create or update issues
      pull-requests: write # Grants permission to create or update pull requests
    needs: check-for-updates
    if: ${{ needs.check-for-updates.outputs.is-update-available == 'true' }}
    strategy: # Runs for each update discovered by the `check-for-updates` job.
      max-parallel: 1 # Ensures that the PRs/issues are created in order.
      matrix:
        tag: ${{ fromJSON(needs.check-for-updates.outputs.new-tags) }}
    steps:
      - name: Run the action
        id: update-the-repo
        uses: leanprover-community/mathlib-update-action/do-update@main
        with:
          tag: ${{ matrix.tag }}
          # START CONFIGURATION BLOCK 2
          # token: ${{ secrets.UPDATE_ACTION_TOKEN }}
          # END CONFIGURATION BLOCK 2
```

You can add configuration options between the two pairs of `START CONFIGURATION BLOCK`/`END CONFIGURATION BLOCK` markers:

### Configuration block 1

This block determines which Mathlib versions to update to.

#### `intermediate_releases`

Controls which Mathlib releases to upgrade to.

Allowed values:

- `all`: update to each release, followed by Mathlib `master` (default)
- `latest`: update only to the newest release, followed by Mathlib `master`
- `stable`: update only to stable Lean releases (no release candidates, no Mathlib `master`)
- `master`: update only to Mathlib `master`

Default: `all`

#### `lake_package_directory`

The directory containing the Lake package to build.
This parameter is passed to the lake-package-directory argument of leanprover/lean-action.
Please ensure this value is the same in configuration block 2.

Default: `.`

#### `legacy_update`

If set to `true`, executes `lake -R -Kenv=dev update` instead of `lake update`.
Please ensure this value is the same in configuration block 2.

Default: `false`

### Configuration block 2

This block determines when and how to update the project.

#### `on_update_succeeds`

What to do when an update is available and the build is successful.

Allowed values:

- `silent`: Do nothing
- `commit`: directly commit the updated files
- `issue`: notify the user by creating an issue. No new issue will be created if one already exists.
- `pr`: notify the user by creating a pull request. No new PR will be created if one already exists.

Default: `pr`.

#### `on_update_fails`

What to do when an update is available and the build fails.

Allowed values:

- `silent`: Do nothing
- `issue`: notify the user by creating an issue. No new issue will be created if one already exists.
- `pr`: notify the user by creating a pull request. No new PR will be created if one already exists.

Default: `issue`.

#### `update_if_modified`

Specifies which files, when updated during `lake update`, will cause the action to update code or notify the user.
This option does not affect the behavior when the build/test/lint fail after `lake update`.

Allowed values:

- `lean-toolchain`:
  If `lean-toolchain` is specified, this GitHub Action will skip updates unless the Lean version is updated.
  Here, "skipping updates" means "not attempting to update code or send notifications when the build/test/lint succeed after lake update".
- `lake-manifest.json`: if `lake-manifest.json` is specified, this GitHub Action will perform an update if any dependent package is updated.

Default: `lake-manifest.json`

#### `build_args`

This GitHub Action uses leanprover/lean-action to build and test the repository.
This parameter determines what to pass to the build-args argument of leanprover/lean-action.

Default: `--log-level=warning`

#### `lake_package_directory`

The directory containing the Lake package to build.
This parameter is passed to the lake-package-directory argument of leanprover/lean-action.
Please ensure this value is the same in configuration block 1.

Default: `.`

#### `token`

A Github token to be used for committing and creating issues/PRs. This is **obligatory** if you want CI to run on the commits created by this action. Create [a fine-grained personal access token](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens) with write permissions for Contents and Pull requests. Add it [as a secret](https://docs.github.com/en/actions/security-for-github-actions/security-guides/using-secrets-in-github-actions) called `UPDATE_ACTION_TOKEN`. Then uncomment the `token:` line in the configuration block.

Default: `${{ github.token }}`

#### `legacy_update`

If set to `true`, executes `lake -R -Kenv=dev update` instead of `lake update`.
Please ensure this value is the same in configuration block 1.

Default: `false`

## Contributing

Before committing code, please run `npm run bundle` to ensure code is formatted and bundled for execution.

If you want to test these actions, feel free to fork Vierkantor/update-tester and make any required modifications

### Implementation notes

The intended workflow uses two jobs, with the output of the first job used to construct a matrix of versions for the second job. This allows us to apply the same workflow to each version found by the `check-for-updates` script, and reuse the logic from `lean-update`. Steps for the first job is available in `action.yml`, steps for the second job in `do-update/action.yml`. Code for the first job is in `src/index.js`, code for the second in `do-update/scripts`.
