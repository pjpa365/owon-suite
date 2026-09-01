import { useEffect, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import {
  ActionIcon,
  AppShell as MantineAppShell,
  Button,
  Group,
  Menu,
  Modal,
  Tabs,
  TextInput,
  Title,
  Tooltip,
  useMantineColorScheme,
} from "@mantine/core";
import { IconInfoCircle, IconSettings } from "@tabler/icons-react";

import { useSettings } from "../../api/settings";
import { useDashboardStore } from "../../state/dashboardStore";
import { useLiveChartOrchestrator } from "../../state/liveChartStream";
import { DashboardGrid } from "./DashboardGrid";
import { DataAdminPage } from "./DataAdminPage";
import { DISCLAIMER_TEXT, Footer } from "./Footer";
import { ManualModal } from "./ManualModal";
import { SettingsModal } from "./SettingsModal";
import { WidgetPalette } from "./WidgetPalette";

function AddDashboardModal({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  const addDashboard = useDashboardStore((s) => s.addDashboard);
  const { register, handleSubmit, reset } = useForm<{ name: string }>({ defaultValues: { name: "" } });

  function onSubmit(values: { name: string }) {
    addDashboard(values.name.trim() || "Untitled");
    reset();
    onClose();
  }

  return (
    <Modal opened={opened} onClose={onClose} title="New dashboard">
      <form onSubmit={handleSubmit(onSubmit)}>
        <Group align="flex-end">
          <TextInput label="Name" style={{ flex: 1 }} {...register("name")} />
          <ActionIcon type="submit" size="lg" aria-label="Create">
            +
          </ActionIcon>
        </Group>
      </form>
    </Modal>
  );
}

export function AppShell() {
  const dashboards = useDashboardStore((s) => s.dashboards);
  const activeDashboardId = useDashboardStore((s) => s.activeDashboardId);
  const defaultDashboardId = useDashboardStore((s) => s.defaultDashboardId);
  const setActiveDashboard = useDashboardStore((s) => s.setActiveDashboard);
  const renameDashboard = useDashboardStore((s) => s.renameDashboard);
  const removeDashboard = useDashboardStore((s) => s.removeDashboard);
  const setDefaultDashboard = useDashboardStore((s) => s.setDefaultDashboard);
  const lockEditing = useDashboardStore((s) => s.lockEditing);
  const toggleLockEditing = useDashboardStore((s) => s.toggleLockEditing);

  const [addOpen, setAddOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);
  const [manualSection, setManualSection] = useState<string | undefined>(undefined);
  // Data admin is a full page swapped in for the dashboard, not a route --
  // there's no router in this app (Changes_post_phase5_and_color_design.txt
  // SS3), so this mirrors the existing dashboard-tab pattern: local view state.
  const [view, setView] = useState<"dashboard" | "admin">("dashboard");
  const activeDashboard = dashboards.find((d) => d.id === activeDashboardId) ?? dashboards[0];

  const settings = useSettings();
  const { setColorScheme } = useMantineColorScheme();
  useLiveChartOrchestrator();

  // Applies the persisted dark/light/auto preference exactly once, the first
  // time settings finish loading. Deliberately NOT re-run on every
  // settings.data change: SettingsModal live-previews an unsaved selection
  // via the same setColorScheme, and re-applying the last-*saved* value here
  // on every render (e.g. a background refetch while the modal is open)
  // fought with that preview and snapped it back before Save was clicked.
  const appliedInitialScheme = useRef(false);
  useEffect(() => {
    if (settings.data && !appliedInitialScheme.current) {
      setColorScheme(settings.data.dark_mode);
      appliedInitialScheme.current = true;
    }
  }, [settings.data, setColorScheme]);

  function handleRename() {
    if (!activeDashboard) return;
    const name = window.prompt("Rename dashboard", activeDashboard.name);
    if (name) renameDashboard(activeDashboard.id, name);
  }

  function handleDelete() {
    if (!activeDashboard) return;
    if (dashboards.length <= 1) {
      window.alert("At least one dashboard must remain.");
      return;
    }
    if (window.confirm(`Delete dashboard "${activeDashboard.name}"? Its widgets will be lost.`)) {
      removeDashboard(activeDashboard.id);
    }
  }

  function openManual(section?: string) {
    setManualSection(section);
    setManualOpen(true);
  }

  return (
    <MantineAppShell header={{ height: 60 }} padding="md">
      <MantineAppShell.Header>
        <Group h="100%" px="md" justify="space-between" wrap="nowrap">
          <Group wrap="nowrap">
            <Tooltip label={DISCLAIMER_TEXT} multiline w={340} withArrow>
              <Group wrap="nowrap" gap="xs" style={{ cursor: "help" }}>
                <img src="/logo.svg" alt="" width={28} height={28} />
                <Title order={4}>Suite for OWON Devices</Title>
              </Group>
            </Tooltip>
            {view === "dashboard" && (
              <>
                <Tabs value={activeDashboardId} onChange={(value) => value && setActiveDashboard(value)}>
                  <Tabs.List>
                    {dashboards.map((dashboard) => (
                      <Tabs.Tab key={dashboard.id} value={dashboard.id}>
                        {dashboard.name}
                        {dashboard.id === defaultDashboardId ? " ★" : ""}
                      </Tabs.Tab>
                    ))}
                  </Tabs.List>
                </Tabs>
                {!lockEditing && (
                  <ActionIcon variant="light" onClick={() => setAddOpen(true)} aria-label="New dashboard">
                    +
                  </ActionIcon>
                )}
                {activeDashboard && (
                  <Menu shadow="md" position="bottom-start">
                    <Menu.Target>
                      <ActionIcon variant="subtle" aria-label="Dashboard options">
                        &#8942;
                      </ActionIcon>
                    </Menu.Target>
                    <Menu.Dropdown>
                      <Menu.Item onClick={handleRename}>Rename "{activeDashboard.name}"</Menu.Item>
                      <Menu.Item onClick={() => setDefaultDashboard(activeDashboard.id)}>
                        Set as default (startup) dashboard
                      </Menu.Item>
                      <Menu.Item onClick={toggleLockEditing}>
                        {lockEditing ? "Unlock dashboard editing" : "Lock dashboard editing"}
                      </Menu.Item>
                      <Menu.Item color="red" onClick={handleDelete}>
                        Delete "{activeDashboard.name}"
                      </Menu.Item>
                    </Menu.Dropdown>
                  </Menu>
                )}
              </>
            )}
          </Group>
          <Group wrap="nowrap" gap="xs">
            {view === "dashboard" && activeDashboard && <WidgetPalette dashboardId={activeDashboard.id} />}
            <Button size="xs" variant="light" onClick={() => setView(view === "admin" ? "dashboard" : "admin")}>
              {view === "admin" ? "Back to dashboard" : "Measurements"}
            </Button>
            <ActionIcon variant="subtle" aria-label="Show manual" onClick={() => openManual()}>
              <IconInfoCircle size={18} />
            </ActionIcon>
            <ActionIcon variant="subtle" aria-label="Settings" onClick={() => setSettingsOpen(true)}>
              <IconSettings size={18} />
            </ActionIcon>
          </Group>
        </Group>
      </MantineAppShell.Header>
      {/* Deliberately more saturated-neutral than the widget card surface (theme-tokens.md SS2) --
          keeps the dashboard background visibly distinct from the widgets sitting on it. */}
      <MantineAppShell.Main style={{ backgroundColor: "var(--app-page-bg)" }}>
        {view === "admin" ? (
          <DataAdminPage />
        ) : (
          <>
            {activeDashboard && <DashboardGrid dashboard={activeDashboard} onOpenManual={openManual} />}
            <Footer />
          </>
        )}
      </MantineAppShell.Main>
      <AddDashboardModal opened={addOpen} onClose={() => setAddOpen(false)} />
      <SettingsModal opened={settingsOpen} onClose={() => setSettingsOpen(false)} onOpenManual={openManual} />
      <ManualModal opened={manualOpen} onClose={() => setManualOpen(false)} section={manualSection} />
    </MantineAppShell>
  );
}
