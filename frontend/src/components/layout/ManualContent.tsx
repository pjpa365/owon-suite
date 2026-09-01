import { List, Stack, Text, Title } from "@mantine/core";

import type { WidgetType } from "../../state/dashboardStore";

export interface ManualSection {
  id: string;
  label: string;
}

// Order here drives both the table of contents and reading order -- keep the
// two in sync by construction rather than maintaining a separate list.
export const MANUAL_SECTIONS: ManualSection[] = [
  { id: "getting-started", label: "Getting started" },
  { id: "purpose", label: "What this app is for" },
  { id: "tabs", label: "Dashboards (tabs)" },
  { id: "widgets-general", label: "Working with widgets" },
  { id: "widget-device-list", label: "Widget: Devices" },
  { id: "widget-meter-display", label: "Widget: Meter display" },
  { id: "widget-live-chart", label: "Widget: Live chart" },
  { id: "widget-recording-control", label: "Widget: Recording control" },
  { id: "widget-scatter-chart", label: "Widget: Scatter/XY chart" },
  { id: "widget-chart-single", label: "Widget: Chart (single)" },
  { id: "widget-chart-multiple", label: "Widget: Chart (multiple)" },
  { id: "data-admin", label: "Data admin page" },
  { id: "settings", label: "Settings page" },
  { id: "mcp-server", label: "MCP server (AI access)" },
];

// Drives the per-widget info icon (WidgetContainer.tsx) -- which manual
// section it jumps to for a given widget instance's type.
export const WIDGET_MANUAL_SECTION: Record<WidgetType, string> = {
  "device-list": "widget-device-list",
  "live-value": "widget-meter-display",
  "live-chart": "widget-live-chart",
  "recording-control": "widget-recording-control",
  "scatter-chart": "widget-scatter-chart",
  "chart-single": "widget-chart-single",
  "chart-multiple": "widget-chart-multiple",
};

function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <Stack id={id} gap="xs" mb="xl" style={{ scrollMarginTop: 12 }}>
      <Title order={3}>{title}</Title>
      {children}
    </Stack>
  );
}

export function ManualContent() {
  return (
    <Stack gap={0}>
      <Section id="getting-started" title="Getting started">
        <Text size="sm">
          This assumes you already have the default dashboard tab open with a few widgets already on it (that's
          how the app starts out of the box). If you're starting from a completely empty dashboard instead, add
          widgets first via <Text span fw={600}>Add widget</Text> in the top-right of the header -- see{" "}
          <Text span fw={600}>Working with widgets</Text> below.
        </Text>
        <List size="sm" type="ordered" spacing="xs">
          <List.Item>
            <Text span fw={600}>Add your meter as a device.</Text> Open the <Text span fw={600}>Devices</Text>{" "}
            widget, click <Text span fw={600}>Add device</Text>, then <Text span fw={600}>Discover nearby meters</Text>{" "}
            (make sure the meter's Bluetooth is on -- long-press REL/BLE on the meter until its Bluetooth icon
            appears). Pick it from the list, give it a name and an identity color, and save. The app will now try
            to connect to it automatically whenever it's advertising (see <Text span fw={600}>Settings page</Text>{" "}
            below for the auto-connect option).
          </List.Item>
          <List.Item>
            <Text span fw={600}>Point the Meter display widget at it.</Text> Open the widget's gear (⚙) icon and
            pick your device. You should immediately start seeing live values once the device connects.
          </List.Item>
          <List.Item>
            <Text span fw={600}>Point the Live chart widget at the same device.</Text> Same gear icon, same device
            picker. You'll see the value trace start moving from left to right.
          </List.Item>
        </List>
        <Text size="sm">
          From here, sensible next steps depend on what you're doing:
        </Text>
        <List size="sm" spacing="xs">
          <List.Item>
            Want to capture a data set right now, without much configuration? Use the{" "}
            <Text span fw={600}>Record</Text> button in the Meter display's right-hand column -- see{" "}
            <Text span fw={600}>Widget: Meter display</Text>.
          </List.Item>
          <List.Item>
            Want a recording with a specific start/stop condition (a threshold, a duration, a sample count, or an
            end time), interval control, or averaging? Add a <Text span fw={600}>Recording control</Text> widget --
            see that section below.
          </List.Item>
          <List.Item>
            Want to log without keeping your PC connected the whole time? Use Recording control's{" "}
            <Text span fw={600}>Offline</Text> mode, which records on the meter itself and downloads afterwards.
          </List.Item>
          <List.Item>
            Want to review, rename, export, or clean up past recordings? See the{" "}
            <Text span fw={600}>Data admin page</Text>.
          </List.Item>
          <List.Item>
            Want to change how dates are formatted, whether devices auto-connect, or per-unit chart colors? See{" "}
            <Text span fw={600}>Settings page</Text>.
          </List.Item>
        </List>
      </Section>

      <Section id="purpose" title="What this app is for">
        <Text size="sm">
          This app connects to OWON-family Bluetooth multimeters, shows their live readings, and records
          measurement data -- either continuously while your PC stays connected ("online" recording) or
          autonomously on the meter itself while disconnected ("offline" recording, downloaded afterwards). It
          keeps a registry of known devices, stores finished recordings in a local database, and lets you review,
          rename, export, and do simple derived calculations (Ah, Watt-hours, shunt current) on that stored data.
          Everything is arranged on one or more customizable dashboards made of widgets.
        </Text>
      </Section>

      <Section id="tabs" title="Dashboards (tabs)">
        <Text size="sm">
          Each tab across the top of the header is a separate dashboard: its own independent set of widgets and
          layout. Switching tabs doesn't lose anything -- widget configuration and layout are saved per dashboard,
          and (as of this app's live-chart data handling) a Live chart widget's history is shared per device across
          every dashboard, so switching away and back doesn't reset what it's showing.
        </Text>
        <List size="sm" spacing="xs">
          <List.Item>
            <Text span fw={600}>Add a dashboard</Text> with the "+" button next to the tabs (hidden while editing
            is locked -- see below).
          </List.Item>
          <List.Item>
            <Text span fw={600}>Rename, delete, or set the default (startup) dashboard</Text> via the "⋮" menu next
            to the tabs. The default dashboard is the one shown with a ★ and is what opens automatically next time
            you start the app. At least one dashboard must always exist.
          </List.Item>
          <List.Item>
            <Text span fw={600}>Lock/unlock dashboard editing</Text> is also in that "⋮" menu. Locking applies
            everywhere (all tabs, all widgets at once) and hides every structural control -- resizing, dragging,
            removing widgets, the gear settings icon, and adding new widgets/dashboards. It does not affect
            anything inside a widget's body: buttons, device pickers, recording controls, and typed values all
            keep working normally. Use this once your layout is the way you want it, so it can't be nudged out of
            place by accident.
          </List.Item>
        </List>
      </Section>

      <Section id="widgets-general" title="Working with widgets">
        <List size="sm" spacing="xs">
          <List.Item>
            <Text span fw={600}>Adding a widget:</Text> use "Add widget" in the header (only visible when editing
            isn't locked) and pick a type. It's placed at the bottom of the current dashboard, and the page
            automatically scrolls down so you can see it appear.
          </List.Item>
          <List.Item>
            <Text span fw={600}>Moving a widget:</Text> drag it by its header (the colored bar showing its title).
          </List.Item>
          <List.Item>
            <Text span fw={600}>Resizing a widget:</Text> drag its bottom-right corner. While resizing, a small
            badge shows the current size in grid blocks (width × height), not pixels -- widgets snap to a grid
            that's 12 blocks wide. Each widget type has a sensible default size and a minimum size it can't shrink
            below.
          </List.Item>
          <List.Item>
            <Text span fw={600}>Configuring a widget:</Text> if a widget has anything to configure, it shows a gear
            (⚙) icon in its header. Click it to open a small settings popover (device picker, colors, thresholds,
            etc. depending on the widget) and click the × in its corner to close it again.
          </List.Item>
          <List.Item>
            <Text span fw={600}>Removing a widget:</Text> the × in its header. This only removes it from the
            dashboard -- it never deletes any recorded data.
          </List.Item>
          <List.Item>
            <Text span fw={600}>Device-scoped widgets</Text> (Meter display, Live chart, Recording control) tint
            their header with that device's identity color and add "— device name" to their title, so you can tell
            at a glance which meter each widget is watching.
          </List.Item>
        </List>
      </Section>

      <Section id="widget-device-list" title="Widget: Devices">
        <Text size="sm">
          The registry of meters this app knows about, and where you connect/disconnect them.
        </Text>
        <List size="sm" spacing="xs">
          <List.Item>
            <Text span fw={600}>Add device</Text> (bottom of the widget) opens a dialog: run{" "}
            <Text span fw={600}>Discover nearby meters</Text> to scan over Bluetooth, pick the meter from the
            results (or type its Bluetooth address by hand), give it a name and pick one of the 8 identity colors,
            then save.
          </List.Item>
          <List.Item>
            If a nearby meter is advertising but isn't registered yet, a pulsing{" "}
            <Text span fw={600}>New Device Found. Add it</Text> button appears automatically -- clicking it
            pre-fills the add-device dialog with that meter's details.
          </List.Item>
          <List.Item>
            Each row shows a connection status dot (green = connected, red = not connected), a{" "}
            <Text span fw={600}>Connect/Disconnect</Text> toggle, a rename/re-color pencil icon, and a delete icon.
          </List.Item>
          <List.Item>
            <Text span fw={600}>Deleting a device only hides it</Text> from this list -- it does not delete any of
            its recorded measurements. If you add the same physical meter back later (same Bluetooth address),
            it reappears as the same device, still linked to all of its old recordings.
          </List.Item>
          <List.Item>
            If the <Text span fw={600}>Settings page</Text>'s auto-connect option is on, this widget shows a note
            ("Auto connects to known devices") and every known device is connected automatically whenever it's in
            range, whether or not this widget is currently visible.
          </List.Item>
          <List.Item>
            If this PC's own Bluetooth is turned off, the widget shows a red warning here instead ("Bluetooth is
            currently not enabled/on...") once at least one device is registered. This check only runs on Windows;
            elsewhere (or if it can't run for any reason) the widget simply shows nothing rather than a false
            warning.
          </List.Item>
        </List>
      </Section>

      <Section id="widget-meter-display" title="Widget: Meter display">
        <Text size="sm">
          A big-digit live readout for one device, with the meter's own function buttons and quick recording
          controls alongside it.
        </Text>
        <List size="sm" spacing="xs">
          <List.Item>
            Pick the device via the gear icon. The digits grow with the widget's size (unit shown at half the digit
            height) and always fit within the widget -- never wrapping to a second line or showing scrollbars -- and
            show the currently measured value, its unit, the active function (e.g. "DC Voltage"), and any status
            flags the meter reports (e.g. HOLD, MIN/MAX).
          </List.Item>
          <List.Item>
            The button grid below the digits mirrors the meter's own physical buttons (SELECT, RANGE, AUTO RANGE,
            HOLD, LIGHT, REL/Δ, Bluetooth off, Hz/Duty, MIN/MAX, NORMAL) -- pressing one sends that command to the
            meter over Bluetooth, the same as pressing it on the device itself. You can hide this button grid via
            the gear icon's "Hide device buttons" option if you only want the readout.
          </List.Item>
          <List.Item>
            The right-hand column is for quick ("ad-hoc") recording: <Text span fw={600}>● Record</Text> starts an
            open-ended recording with no configuration needed. While recording, a pulsing red dot replaces the
            button, with <Text span fw={600}>Pause/Resume</Text> and <Text span fw={600}>Stop</Text> beneath it. A
            hollow (unfilled) dot means the recording is currently paused. Stopping finalizes and stores it as a
            data set, viewable in the Data admin page.
          </List.Item>
          <List.Item>
            For recordings with an actual stop condition (a duration, a sample count, an end time, or a value
            threshold), use a <Text span fw={600}>Recording control</Text> widget instead -- the Record button here
            is deliberately simple/no-config.
          </List.Item>
        </List>
      </Section>

      <Section id="widget-live-chart" title="Widget: Live chart">
        <Text size="sm">
          A scrolling line chart of one device's live values, sharing the same underlying data across every Live
          chart widget watching that device (any dashboard, whether or not it's the active tab) -- so switching
          tabs away and back never resets what's shown.
        </Text>
        <List size="sm" spacing="xs">
          <List.Item>
            Configure via the gear icon: pick the device, and set how many of the most recent values to show at
            once ("Number of values (horizontal)"). The chart line grows from left to right and only ever scrolls
            -- there's no compression or rescaling as new points arrive; once full, the oldest point simply drops
            off the left.
          </List.Item>
          <List.Item>
            The line color follows the global per-unit chart color set on the <Text span fw={600}>Settings page</Text>{" "}
            (so a Voltage trace always uses the same color everywhere, for example).
          </List.Item>
          <List.Item>
            <Text span fw={600}>Auto Y-axis offset</Text> (gear icon, on by default): instead of always starting the
            vertical axis at 0, it starts at a rounded-down boundary just below the lowest value currently on
            screen -- e.g. values hovering around 93-103 get an axis starting at 90 rather than 0, so a small
            ripple riding on a high baseline is actually visible instead of squashed flat. Turn it off to force the
            axis back to starting at 0.
          </List.Item>
          <List.Item>
            <Text span fw={600}>Pause/unpause</Text> (top-right of the chart body) freezes this chart's own display
            -- data keeps arriving underneath, and unpausing jumps straight to the latest values (nothing is lost
            or skipped). This is local to that one chart: if two Live chart widgets are open for the same device
            and you pause one, the other keeps moving. Use this to hold a chart steady while you inspect or export
            it.
          </List.Item>
          <List.Item>
            If a device changes what it's measuring (e.g. its function switches from Voltage to Current), the
            chart's history is cleared automatically rather than mixing two different units on one line.
          </List.Item>
          <List.Item>
            The floppy-disk icon (top-right) saves the device's current live buffer as a proper, named stored data
            set -- viewable afterwards on the <Text span fw={600}>Data admin page</Text>.
          </List.Item>
          <List.Item>The download icon (top-right) saves the currently visible chart as an image.</List.Item>
        </List>
      </Section>

      <Section id="widget-recording-control" title="Widget: Recording control">
        <Text size="sm">
          The full-featured recording widget: choose Online or Offline, set exactly when it should start and stop,
          and how often it should sample.
        </Text>
        <List size="sm" spacing="xs">
          <List.Item>
            Via the gear icon, this widget can either float ("Any device", with an in-body picker) or lock to one
            specific device ("Selected device", shown in the widget's own title instead).
          </List.Item>
          <List.Item>
            <Text span fw={600}>Offline (device)</Text> mode records autonomously on the meter itself -- you don't
            need to keep your PC or the Bluetooth connection alive for the duration. Set an interval and a stop
            condition (sample count, duration, or an end time), start it, and you can disconnect. Long-press the
            meter's REL/BLE (Δ/ᛒ) button to reconnect when you want the recording downloaded and stored; progress
            (waiting for reconnect, downloading, completed) is shown live. If the global "set meter clock at
            initiation" setting is off and you're using an end-time stop condition, a warning explains that the
            meter's own idea of "now" may be off, which can shift when it actually stops.
          </List.Item>
          <List.Item>
            <Text span fw={600}>Online (PC)</Text> mode records on this PC while connected, with more stop-condition
            options: a value threshold, a sample count, a fixed duration, or a specific end time (which can't be set
            in the past). It also supports an optional start condition (only begin once a value crosses a
            threshold), an interval with optional averaging (vs. just using the last value in each interval), and
            stopping automatically on low battery. While active you get Pause/Resume/Stop controls and a live
            sample count; once finished, a summary panel shows the resulting data set's name and why it stopped,
            until you dismiss it.
          </List.Item>
        </List>
      </Section>

      <Section id="widget-scatter-chart" title="Widget: Scatter/XY chart">
        <Text size="sm">
          Plots one stored measurement against another (X vs. Y) -- useful for e.g. a discharge curve of Voltage
          vs. Current. Pick both measurements directly in the widget body. Since the two data sets rarely share
          exact timestamps, points are time-aligned automatically; any point that had to be interpolated to make
          that alignment is drawn in gray rather than the normal series color, so it's never mistaken for an
          actually-measured point.
        </Text>
      </Section>

      <Section id="widget-chart-single" title="Widget: Chart (single)">
        <Text size="sm">
          A full-history chart of one stored measurement, with an optional live transform applied to every value
          before it's plotted.
        </Text>
        <List size="sm" spacing="xs">
          <List.Item>
            Configure via the gear icon: a plain scrollable list of every stored measurement, newest first (no
            filters -- for that, use the Data admin page to find the exact one first). Pick one to chart it.
          </List.Item>
          <List.Item>
            Depending on the selected measurement's unit, an optional function can also be applied: Voltage
            measurements can be converted to current via a shunt resistance value (I = U / R), Ohm measurements to
            current via a constant voltage (I = V / R), and Current measurements to power via a constant voltage
            (P = I x V). The function and its value are saved with the widget, but only ever affect what's
            displayed -- if you also save this measurement elsewhere, the original device values are what get
            stored, never the transformed ones.
          </List.Item>
          <List.Item>
            The widget's header shows the source device's identity color and is titled "Chart - " followed by the
            measurement's name. The download icon (top-right) saves the chart as an image.
          </List.Item>
          <List.Item>
            <Text span fw={600}>Auto Y-axis offset</Text> (gear icon, on by default): starts the vertical axis at a
            rounded-down boundary just below the data's lowest value instead of always starting at 0, so a small
            ripple riding on a high baseline stays visible. Turn it off for the traditional from-0 axis.
          </List.Item>
        </List>
      </Section>

      <Section id="widget-chart-multiple" title="Widget: Chart (multiple)">
        <Text size="sm">
          Overlays several stored measurements -- from any devices -- on one chart, each as its own colored line.
        </Text>
        <List size="sm" spacing="xs">
          <List.Item>
            Configure via the gear icon: the same plain, unfiltered, newest-first list as Chart (single), but with
            checkboxes for selecting multiple measurements at once.
          </List.Item>
          <List.Item>
            Selected measurements are limited to at most 2 different units at a time (one per vertical axis, left
            and right). Once 2 units are in play, any measurement with a 3rd unit is grayed out and unselectable in
            the list -- you can still add more measurements, just from the 2 units already chosen.
          </List.Item>
          <List.Item>
            Each keeps its own original sample spacing (no interpolation), so a measurement sampled every 2 seconds
            will naturally show more points than one sampled every 10. The <Text span fw={600}>Chart time axis</Text>{" "}
            setting (Settings page) controls whether the horizontal axis shows each point's real recorded time, or
            every measurement's own elapsed time from a shared start (t0) -- useful for comparing recordings made on
            different days. That setting applies to every time-based chart, not just this one.
          </List.Item>
          <List.Item>
            A color-swatch legend sits above the chart, wrapping to more rows on a narrow widget rather than
            overlapping the plot area -- resize the widget taller if it needs more room. It's a separate section,
            not part of the chart itself, so it isn't included when you download the chart as an image (top-right).
          </List.Item>
          <List.Item>
            The header stays neutral (no device tint, since multiple devices can be involved) and is titled
            "Chart - N measurements, &lt;units&gt;".
          </List.Item>
          <List.Item>
            <Text span fw={600}>Auto Y-axis offset</Text> (gear icon, on by default) applies to both the left and
            right axes independently -- each starts at a rounded-down boundary just below that axis's own lowest
            value instead of 0, so one unit's baseline can't drag the other axis's offset around. Turn it off for
            the traditional from-0 axes.
          </List.Item>
        </List>
      </Section>

      <Section id="data-admin" title="Data admin page">
        <Text size="sm">
          Reached via the "Data admin" button in the header. The one place to review, rename, export, calculate on,
          and bulk-clean-up every stored recording.
        </Text>
        <List size="sm" spacing="xs">
          <List.Item>
            The left-hand list is a filterable browser of every stored recording (filters: device, name, and date
            range -- hover any filter field for a tooltip explaining what it matches). Selecting a data set loads
            its individual points on the right.
          </List.Item>
          <List.Item>
            Each row in that list also has action icons: rename (✎), run a <Text span fw={600}>Calculate</Text>{" "}
            (∑), export to CSV, or delete the whole recording. <Text span fw={600}>Calculate:</Text> Amp-hours
            works on a single current measurement; Watt-hours needs a paired voltage and current measurement (or a
            constant for whichever one isn't picked), values time-aligned automatically, interpolating where the
            two don't share exact timestamps; Shunt-current computes current from a voltage measurement across a
            shunt resistor, given its resistance. A fourth, general tab is also available -- labeled "V to I or R",
            "Ohm to V or I", or "A to V or R" depending on the measurement's own unit -- where you pick which of
            the other two quantities is held constant and enter its value, and the third is computed at every
            point via Ohm's law (U = I x R). This overlaps with Shunt-current for a voltage measurement with a
            constant resistance -- both compute the same thing; use whichever you find clearer.
          </List.Item>
          <List.Item>
            The records list on the right shows every point in the selected recording, oldest first, with a
            checkbox per row. <Text span fw={600}>Delete selected</Text> removes only the checked rows.
          </List.Item>
          <List.Item>
            <Text span fw={600}>Delete top ↔ selection</Text> and <Text span fw={600}>Delete selection ↔ bottom</Text>{" "}
            are range deletes: check one or two rows, and these remove everything from the very first row through
            your topmost checked row, or from your bottommost checked row through the very last row, respectively
            -- handy for trimming a run of bad readings at the start or end of a recording without deleting them
            one at a time. Every delete asks for confirmation and states exactly how many rows will be removed.
          </List.Item>
        </List>
      </Section>

      <Section id="settings" title="Settings page">
        <Text size="sm">Reached via the gear icon in the header. Applies globally, across every dashboard.</Text>
        <List size="sm" spacing="xs">
          <List.Item>
            <Text span fw={600}>Appearance:</Text> Light, Dark, or Auto (follows your OS setting).
          </List.Item>
          <List.Item>
            <Text span fw={600}>Date &amp; time format:</Text> a single editable template used everywhere a date
            and/or time is shown. A screen that shows only a date, or only a time, automatically uses just that
            half of the template (split on the first space) -- "What tokens can I use?" explains the exact
            syntax with a live preview.
          </List.Item>
          <List.Item>
            <Text span fw={600}>Devices:</Text> whether known devices auto-connect whenever their Bluetooth is on,
            and whether starting an offline recording sets the meter's clock from this PC's system time first
            (recommended if you rely on an end-time stop condition for offline recordings).
          </List.Item>
          <List.Item>
            <Text span fw={600}>Default chart colors:</Text> one color per measurement unit, separately for light
            and dark mode, used by Live chart (and anywhere else a unit-colored line/series appears).
          </List.Item>
          <List.Item>
            <Text span fw={600}>Chart time axis:</Text> "Time of measurement" (each point's real recorded time) or
            "Relative to first data point" (elapsed seconds since the chart's own first point) -- applies to every
            time-based chart at once: Live chart, Chart (single), and Chart (multiple).
          </List.Item>
          <List.Item>
            <Text span fw={600}>Measurement naming template:</Text> the pattern used to auto-name a data set once a
            recording finishes (device name, start time, min/max, duration, sample count, etc.), with a live
            preview and a reset-to-default button.
          </List.Item>
          <List.Item>
            <Text span fw={600}>MCP server:</Text> lets an AI assistant read your devices and stored recordings,
            press buttons, and start/stop recordings over the network -- see{" "}
            <Text span fw={600}>MCP server (AI access)</Text> below.
          </List.Item>
        </List>
      </Section>

      <Section id="mcp-server" title="MCP server (AI access)">
        <Text size="sm">
          MCP (Model Context Protocol) lets an AI assistant -- e.g. Claude Desktop -- connect to this app directly:
          read your devices and stored recordings, press the meter's buttons, and start/stop recordings, the same
          things you can do from the dashboard yourself. Configured on the{" "}
          <Text span fw={600}>Settings page</Text>, off by default.
        </Text>
        <List size="sm" type="ordered" spacing="xs">
          <List.Item>
            <Text span fw={600}>Enable MCP server</Text> turns the feature on at all. With it off, nothing outside
            this PC can reach it, regardless of anything else below.
          </List.Item>
          <List.Item>
            <Text span fw={600}>Allow ad-hoc data queries</Text> is a second, independent switch specifically for
            the "ask a free-form question across recordings" capability (see below). You can leave this off while
            still allowing the simpler "what devices do I have / are they online / what are the latest readings"
            questions.
          </List.Item>
          <List.Item>
            <Text span fw={600}>API key</Text> is a key you choose yourself (not generated by the app) -- any
            device on your network trying to reach the MCP server has to send this same key, or it's refused. This
            PC itself never needs it; the key only matters for connections coming from elsewhere on your network.
          </List.Item>
        </List>
        <Text size="sm" mt="xs">
          What the AI assistant can do with this:
        </Text>
        <List size="sm" spacing="xs">
          <List.Item>List your known devices and whether each is currently online.</List.Item>
          <List.Item>Get the most recent live readings for a device (up to the app's buffer size).</List.Item>
          <List.Item>
            List your stored recordings with the same filters as the Data admin page (device, name, date range),
            with sorting options that page doesn't even offer (by name, unit, or device, not just newest first) --
            and read back every recorded value for one of them, oldest first.
          </List.Item>
          <List.Item>
            If ad-hoc queries are allowed: ask questions that span one or more stored recordings at once -- e.g.
            "what's the highest value recorded on this meter, and did any other recording exceed it within the
            first 10 seconds." This is strictly read-only and can only see device names, recording metadata, and
            recorded values -- never anything else stored by the app (e.g. your mobile PIN), and it can never
            change, delete, or create anything. A question that isn't a plain read is refused outright with an
            error rather than partially answered.
          </List.Item>
          <List.Item>
            <Text span fw={600}>Press any of the meter's 10 buttons</Text> on a connected device -- the same
            SELECT/RANGE/AUTO RANGE/HOLD/LIGHT/REL(Δ)/BT off/Hz-Duty/MIN-MAX/NORMAL actions available from the
            Meter display widget's own button grid.
          </List.Item>
          <List.Item>
            <Text span fw={600}>Start, pause, resume, or stop a recording</Text> -- the dashboard's quick
            (Record) button, the Recording control widget's full "Online (PC)" mode (thresholds, duration, sample
            count, end time, interval, averaging), and its "Offline (device)" mode. The AI is expected to check
            progress itself (the same status the Recording control widget shows) rather than assume a recording
            finished the moment it was started, and to fetch the actual data afterwards using the listing/read-back
            capability above. For an offline recording specifically, the AI can start it, but downloading the
            result afterwards still needs a person to physically long-press REL/BLE on the meter -- that part
            can't be done remotely, and the AI is expected to say so rather than guess when it'll be done.
          </List.Item>
        </List>
        <Text size="sm" mt="xs">
          It can never lock you out: there's no "who's in control" switch between you and the AI -- both can press
          buttons or start/stop recordings at any time, and whichever one acts first simply goes first, the same
          as if two people reached for the same button. If the AI tries something that conflicts with what's
          already happening (e.g. starting a recording while one is already running), it's told so plainly and
          nothing happens, the same error the dashboard itself would show you in that situation.
        </Text>
        <Text size="sm" mt="xs">
          To connect an MCP-capable AI assistant, point it at{" "}
          <Text span fw={600}>
            http://&lt;this PC's network address&gt;:10765/mcp
          </Text>{" "}
          (find that address the same way you would for the mobile client), sending your chosen API key in a{" "}
          <Text span fw={600}>X-MCP-Key</Text> header with every request. The exact place to enter this differs by
          assistant; for a client that accepts a JSON configuration for remote MCP servers, it looks like:
        </Text>
        <Text
          size="xs"
          ff="monospace"
          p="xs"
          style={{
            whiteSpace: "pre",
            overflowX: "auto",
            background: "var(--mantine-color-default-hover)",
            borderRadius: 6,
          }}
        >
{`{
  "mcpServers": {
    "owon-meter": {
      "url": "http://<this PC's network address>:10765/mcp",
      "headers": {
        "X-MCP-Key": "<the API key you set in Settings>"
      }
    }
  }
}`}
        </Text>
        <Text size="sm" mt="xs">
          As general caution rather than a hard rule: avoid running a large or complex query while a recording is
          actively in progress.
        </Text>
      </Section>
    </Stack>
  );
}
