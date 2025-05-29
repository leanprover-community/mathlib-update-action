import core from "@actions/core";
import { execSync } from "child_process";

/**
 * Turn an array of issue/PR data into a bulleted list. For example:
 * 	[{ number: 1 }, { number: 37 }, { number: 1234 }]
 * becomes:
 * 	"""* #1
 * 	* #37
 * 	* #1234"""
 *
 * The resulting string has no leading or trailing whitespace (such as linebreaks).
 */
function formatIssueList(issueNumbers) {
  return issueNumbers.map((issue) => `* #${issue.number}`).join("\n");
}

const openPRs = JSON.parse(
  execSync('gh pr list --label "auto-update-lean" --state open --json number'),
);
const openIssues = JSON.parse(
  execSync(
    'gh issue list --label "auto-update-lean" --state open --json number',
  ),
);

core.setOutput("previous-issues-exist", openIssues.length > 0);
core.setOutput("previous-prs-exist", openPRs.length > 0);

var summaryText = "";
if (openPRs.length > 0) {
  summaryText += `\n\nPrevious unmerged auto-update PRs:\n${formatIssueList(openPRs)}`;
}
if (openIssues.length > 0) {
  summaryText += `\n\nPrevious open auto-update issues:\n${formatIssueList(openIssues)}`;
}
core.setOutput("summary-text", summaryText);
