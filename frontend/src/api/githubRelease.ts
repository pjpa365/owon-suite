import { useQuery } from "@tanstack/react-query";

// Anonymous, no-auth call to GitHub's public API -- same endpoint install.ps1
// itself queries to find "the latest release". Purely a "is there a newer
// version" convenience for the footer; failures are silent (no error state
// surfaced) since this is a nice-to-have, not core app functionality, and
// this app is otherwise fully offline-capable. Cached for an hour with no
// refetch-on-focus so normal use doesn't repeatedly hit GitHub's anonymous
// rate limit (60 requests/hour per IP).
const LATEST_RELEASE_URL = "https://api.github.com/repos/pjpa365/owon-suite/releases/latest";

interface LatestRelease {
  version: string;
  url: string;
}

export function useLatestRelease() {
  return useQuery<LatestRelease>({
    queryKey: ["github", "owon-suite", "latest-release"],
    queryFn: async () => {
      const resp = await fetch(LATEST_RELEASE_URL);
      if (!resp.ok) throw new Error(`GitHub API returned ${resp.status}`);
      const data = (await resp.json()) as { tag_name: string; html_url: string };
      return { version: data.tag_name.replace(/^v/, ""), url: data.html_url };
    },
    staleTime: 60 * 60 * 1000,
    refetchOnWindowFocus: false,
    retry: false,
  });
}
