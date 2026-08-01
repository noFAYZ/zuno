/**
 * External destinations the app links out to.
 *
 * Shared rather than inlined: the repository URL is now referenced from both the title bar
 * and the settings page, and a project that gets forked or renamed should only have to
 * change it here.
 */
export const GITHUB_REPOSITORY_URL = "https://github.com/noFAYZ/zuno";
export const GITHUB_NEW_ISSUE_URL = `${GITHUB_REPOSITORY_URL}/issues/new/choose`;
export const GITHUB_RELEASES_URL = `${GITHUB_REPOSITORY_URL}/releases`;
