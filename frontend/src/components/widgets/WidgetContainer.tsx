import { ActionIcon, Badge, Group, Paper, Popover, Text } from "@mantine/core";
import { IconInfoCircle, IconSettings, IconX } from "@tabler/icons-react";
import type { ReactNode } from "react";
import { useState } from "react";

interface WidgetContainerProps {
  title: string;
  onRemove: () => void;
  children: ReactNode;
  /** Resolved (scheme-appropriate) device tint for widgets bound to exactly one
   * device (theme-tokens.md SS4) -- omitted for generic widgets, which keep the
   * plain neutral header. Header background ONLY: body, border, and text stay
   * exactly as the neutral case, so device identity never touches readability. */
  headerColor?: string;
  /** Dashboard-wide editing lock (Changes_post_phase5_and_color_design.txt SS8) --
   * hides structural controls (remove, gear) while leaving widget contents
   * interactive. Resize/drag themselves are disabled one level up, on ReactGridLayout. */
  locked?: boolean;
  /** "w x h" in grid blocks, shown as an overlay badge while this widget is
   * being resized, so min/default sizes can be tuned by eye (section 6). */
  sizeOverlay?: string;
  /** Per-widget-type config form (section 5) -- a gear icon only appears when
   * a widget actually has settings to show. Generic on purpose: any widget
   * type can plug in a settings form here, not just the three that do today. */
  settingsContent?: ReactNode;
  /** Opens the user manual jumped to this widget type's section -- shown
   * regardless of the editing lock (it's informational, not structural, so
   * SS8's lock doesn't apply to it). Omitted entirely means no info icon. */
  onShowManual?: () => void;
}

export function WidgetContainer({
  title,
  onRemove,
  children,
  headerColor,
  locked,
  sizeOverlay,
  settingsContent,
  onShowManual,
}: WidgetContainerProps) {
  const [settingsOpen, setSettingsOpen] = useState(false);

  return (
    <Paper
      radius={10}
      h="100%"
      style={{
        position: "relative",
        display: "flex",
        flexDirection: "column",
        backgroundColor: "var(--app-card-surface)",
        border: "2px solid var(--mantine-color-default-border)",
      }}
    >
      <Group
        justify="space-between"
        px="sm"
        py={4}
        className="widget-drag-handle"
        style={{
          cursor: locked ? "default" : "move",
          backgroundColor: headerColor ?? "var(--app-widget-header-bg)",
          borderBottom: "2px solid var(--mantine-color-default-border)",
          borderRadius: "8px 8px 0 0",
        }}
      >
        <Text size="sm" fw={600} lineClamp={1}>
          {title}
        </Text>
        <Group gap={2} wrap="nowrap">
          {onShowManual && (
            <ActionIcon
              size="sm"
              variant="subtle"
              aria-label="Show manual"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={onShowManual}
            >
              <IconInfoCircle size={16} />
            </ActionIcon>
          )}
          {!locked && (
            <>
              {settingsContent && (
                <Popover
                  width={260}
                  position="bottom-end"
                  withArrow
                  shadow="md"
                  opened={settingsOpen}
                  onChange={setSettingsOpen}
                >
                  <Popover.Target>
                    <ActionIcon
                      size="sm"
                      variant="subtle"
                      aria-label="Widget settings"
                      onMouseDown={(e) => e.stopPropagation()}
                      onClick={() => setSettingsOpen((o) => !o)}
                    >
                      <IconSettings size={16} />
                    </ActionIcon>
                  </Popover.Target>
                  <Popover.Dropdown onMouseDown={(e) => e.stopPropagation()}>
                    <Group justify="flex-end" mb={4}>
                      <ActionIcon
                        size="xs"
                        variant="subtle"
                        aria-label="Close settings"
                        onClick={() => setSettingsOpen(false)}
                      >
                        <IconX size={14} />
                      </ActionIcon>
                    </Group>
                    {settingsContent}
                  </Popover.Dropdown>
                </Popover>
              )}
              <ActionIcon size="sm" variant="subtle" color="red" onClick={onRemove} aria-label="Remove widget">
                &times;
              </ActionIcon>
            </>
          )}
        </Group>
      </Group>
      <div style={{ flex: 1, overflow: "auto", padding: "0.5rem" }}>{children}</div>
      {sizeOverlay && (
        <Badge
          color="accent"
          style={{ position: "absolute", top: 8, right: 8, pointerEvents: "none", zIndex: 10 }}
        >
          {sizeOverlay}
        </Badge>
      )}
    </Paper>
  );
}
