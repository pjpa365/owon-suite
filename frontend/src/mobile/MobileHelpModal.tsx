import { List, Modal, Stack, Text, Title } from "@mantine/core";

export function MobileHelpModal({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  return (
    <Modal opened={opened} onClose={onClose} title="How to use this" size="lg">
      <Stack gap="md">
        <Text size="sm">
          A phone-friendly companion to the PC dashboard: pick one of your known meters and see its live reading,
          controls, and a live chart, without needing the PC dashboard's fuller (but denser) screens.
        </Text>

        <div>
          <Title order={5}>Getting in</Title>
          <Text size="sm">
            The PIN you enter is remembered on this phone from then on — you won't be asked again unless the PIN is
            changed or cleared on the PC, or this phone's browser data is cleared.
          </Text>
        </div>

        <div>
          <Title order={5}>Meter section</Title>
          <List size="sm" spacing={4}>
            <List.Item>The live reading and unit, with the meter's active function shown above it.</List.Item>
            <List.Item>
              <Text span fw={600}>
                Show buttons / Hide buttons
              </Text>{" "}
              (plain text, not a button) toggles the grid of physical-button equivalents below it.
            </List.Item>
            <List.Item>
              <Text span fw={600}>
                ● Record
              </Text>{" "}
              (top right) starts a simple recording; while active it becomes Pause/Resume and Stop, matching the PC
              dashboard's Meter display widget.
            </List.Item>
          </List>
        </div>

        <div>
          <Title order={5}>Chart section</Title>
          <List size="sm" spacing={4}>
            <List.Item>Pause/Resume freezes the chart's own display without affecting the recording.</List.Item>
            <List.Item>The floppy-disk icon saves the current live buffer as a stored data set.</List.Item>
            <List.Item>The eraser icon clears the chart and restarts its time reference from that point.</List.Item>
            <List.Item>
              The timeline icon sets how many seconds of data the chart shows at once (default 30) — older points
              fall off the left as new ones arrive on the right, whatever that number is.
            </List.Item>
          </List>
        </div>

        <div>
          <Title order={5}>Layout &amp; display</Title>
          <List size="sm" spacing={4}>
            <List.Item>Portrait: meter on top, chart below. Landscape: meter on the left, chart on the right.</List.Item>
            <List.Item>
              Picking a device also switches the phone to full-screen, where supported (mainly Android).
            </List.Item>
            <List.Item>
              The sun/moon icon switches between light and dark just for this phone, this session — it doesn't
              change the PC dashboard's own appearance setting, and resets next time you open this page.
            </List.Item>
          </List>
        </div>
      </Stack>
    </Modal>
  );
}
