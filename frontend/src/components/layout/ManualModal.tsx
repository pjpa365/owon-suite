import { useEffect } from "react";
import { Anchor, Divider, Modal, ScrollArea, Stack, Text } from "@mantine/core";

import { MANUAL_SECTIONS, ManualContent } from "./ManualContent";

interface ManualModalProps {
  opened: boolean;
  onClose: () => void;
  /** Section id to scroll to on open (ManualContent.tsx's MANUAL_SECTIONS/
   * WIDGET_MANUAL_SECTION) -- omitted/undefined means "start from the top". */
  section?: string;
}

export function ManualModal({ opened, onClose, section }: ManualModalProps) {
  // Re-run on every open (not just when `section` changes) so re-opening the
  // manual from a different widget's info icon while it's already showing
  // the same section still jumps -- and so opening at the top always resets
  // scroll position rather than remembering the last spot.
  useEffect(() => {
    if (!opened) return;
    const id = section ?? MANUAL_SECTIONS[0].id;
    // Wait a tick for the Modal's content to actually be mounted/laid out.
    const timer = setTimeout(() => {
      document.getElementById(id)?.scrollIntoView({ block: "start" });
    }, 50);
    return () => clearTimeout(timer);
  }, [opened, section]);

  function jumpTo(id: string) {
    document.getElementById(id)?.scrollIntoView({ block: "start", behavior: "smooth" });
  }

  return (
    <Modal opened={opened} onClose={onClose} title="User manual" size="900px">
      <ScrollArea.Autosize mah="75vh">
        <Stack gap={4} mb="lg">
          <Text size="sm" fw={600}>
            Contents
          </Text>
          {MANUAL_SECTIONS.map((s) => (
            <Anchor key={s.id} size="sm" onClick={() => jumpTo(s.id)}>
              {s.label}
            </Anchor>
          ))}
        </Stack>
        <Divider mb="lg" />
        <ManualContent />
      </ScrollArea.Autosize>
    </Modal>
  );
}
