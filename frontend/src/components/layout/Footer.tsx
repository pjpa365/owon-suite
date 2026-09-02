import { useState } from "react";
import { Anchor, Group, Modal, Text } from "@mantine/core";

import { useLatestRelease } from "../../api/githubRelease";

export const DISCLAIMER_TEXT =
  'Suite for OWON Devices is an independent software product developed by pjpa365. It is ' +
  "not affiliated with, sponsored by, or endorsed by OWON/Lilliput Group. OWON™ is a " +
  "major product line and brand wholly owned and managed by the Lilliput Group, registered " +
  "in China";

// Falls back to "dev" rather than a hardcoded number -- VITE_APP_VERSION is
// auto-generated from package.json by vite.config.ts (mirrors VITE_API_BASE_URL's
// pattern in api/client.ts), so a missing value means that step never ran.
const APP_VERSION = import.meta.env.VITE_APP_VERSION ?? "dev";

export function AboutModal({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  return (
    <Modal opened={opened} onClose={onClose} title="About">
      <Text size="sm">{DISCLAIMER_TEXT}</Text>
    </Modal>
  );
}

export function Footer() {
  const [aboutOpen, setAboutOpen] = useState(false);
  const latestRelease = useLatestRelease();

  return (
    <Group justify="center" gap="xs" py="md" style={{ color: "var(--app-text-faint)" }}>
      <Text size="xs">Installed: v{APP_VERSION}</Text>
      {latestRelease.data && (
        <>
          <Text size="xs">&middot;</Text>
          <Anchor
            size="xs"
            c="var(--app-text-faint)"
            href={latestRelease.data.url}
            target="_blank"
            rel="noopener noreferrer"
          >
            Latest: v{latestRelease.data.version}
          </Anchor>
        </>
      )}
      <Text size="xs">&middot;</Text>
      <Anchor size="xs" c="var(--app-text-faint)" onClick={() => setAboutOpen(true)}>
        About
      </Anchor>
      <AboutModal opened={aboutOpen} onClose={() => setAboutOpen(false)} />
    </Group>
  );
}
