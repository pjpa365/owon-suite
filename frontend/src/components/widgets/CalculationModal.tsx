import { useState } from "react";
import {
  Alert,
  Badge,
  Button,
  Checkbox,
  Group,
  Modal,
  NumberInput,
  Radio,
  Select,
  Stack,
  Tabs,
  Text,
  useComputedColorScheme,
} from "@mantine/core";

import { useCalculateAh, useCalculateOhmsLaw, useCalculateShuntCurrent, useCalculateWattHour } from "../../api/calculations";
import { useMeasurements } from "../../api/measurements";
import type {
  AhResponse,
  CalculationStats,
  MeasurementSummary,
  OhmsLawQuantity,
  OhmsLawResponse,
  ShuntCurrentResponse,
  WattHourResponse,
} from "../../api/types";
import { CHIP_HUES, chipStyle } from "../../utils/statusChip";

function isCurrentUnit(unit: string): boolean {
  return unit.endsWith("A");
}

function isVoltageUnit(unit: string): boolean {
  return unit.endsWith("V");
}

function isResistanceUnit(unit: string): boolean {
  return unit.endsWith("Ohm");
}

// V to I or R / Ohm to V or I / A to V or R (Changes ausgust-25.txt item 11)
// -- "quantity" here, not "unit", to match the backend's OhmsLawQuantity
// vocabulary (Resistor/Ohm's unit string is "Ohm" plus a scale prefix, not
// a fixed suffix like V/A, so it isn't a plain unit check the way the other
// two are).
const OHMS_LAW_TAB_LABEL: Record<OhmsLawQuantity, string> = { V: "V to I or R", R: "Ohm to V or I", I: "A to V or R" };
const OHMS_LAW_FIELD_LABEL: Record<OhmsLawQuantity, string> = { V: "Voltage", I: "Current", R: "Resistor/Ohm" };
const OHMS_LAW_UNIT_SUFFIX: Record<OhmsLawQuantity, string> = { V: "V", I: "A", R: "Ω" };
const OHMS_LAW_UNIT_NAME: Record<OhmsLawQuantity, string> = { V: "Volt", I: "Amp", R: "Ohm" };

// Mantine's NumberInput onChange can pass back an in-progress *string*
// (e.g. "0." while typing "0.1") rather than a number -- storing that as ""
// instead of keeping the string wipes out what was just typed and makes
// decimals like 0.1/0.01 effectively untypeable. Keep the raw value in
// state and only parse to a number where it's actually used.
function toNumber(value: number | string): number {
  return typeof value === "number" ? value : parseFloat(value);
}

function StatRow({ label, value, unit, decimals = 4 }: { label: string; value: number | null; unit?: string; decimals?: number }) {
  return (
    <Group justify="space-between" wrap="nowrap" gap="xs">
      <Text size="sm" c="dimmed">
        {label}
      </Text>
      <Text size="sm" fw={500}>
        {value === null ? "—" : `${value.toFixed(decimals)}${unit ? ` ${unit}` : ""}`}
      </Text>
    </Group>
  );
}

function HeadlineResult({ label, value, unit }: { label: string; value: number; unit: string }) {
  return (
    <Stack gap={0} align="center" py="xs">
      <Text size="xs" c="dimmed" tt="uppercase" fw={600}>
        {label}
      </Text>
      <Text size="xl" fw={700} c="brand">
        {value.toFixed(4)} {unit}
      </Text>
    </Stack>
  );
}

function StatsRows({ stats, unit }: { stats: CalculationStats; unit: string }) {
  return (
    <Stack gap={4}>
      <StatRow label="Duration" value={stats.duration_seconds} unit="s" decimals={1} />
      <StatRow label="Count" value={stats.count} decimals={0} />
      <StatRow label="Min" value={stats.min_value} unit={unit} />
      <StatRow label="Max" value={stats.max_value} unit={unit} />
      <StatRow label="Average" value={stats.avg_value} unit={unit} />
      <StatRow label="Median" value={stats.median_value} unit={unit} />
    </Stack>
  );
}

function AhTab({ measurement }: { measurement: MeasurementSummary }) {
  const calculateAh = useCalculateAh();
  const [result, setResult] = useState<AhResponse | null>(null);

  return (
    <Stack gap="sm" pt="sm">
      <Text size="sm" c="dimmed">
        Ampere-hours over the full duration of "{measurement.name}".
      </Text>
      <Group>
        <Button
          size="xs"
          loading={calculateAh.isPending}
          onClick={() => calculateAh.mutate({ measurement_id: measurement.id }, { onSuccess: setResult })}
        >
          Calculate
        </Button>
      </Group>
      {calculateAh.isError && (
        <Alert color="red" title="Calculation failed">
          {(calculateAh.error as Error).message}
        </Alert>
      )}
      {result && (
        <Stack gap="sm">
          <HeadlineResult label="Ampere-hours" value={result.ah_value} unit="Ah" />
          <StatsRows stats={result.stats} unit={measurement.unit} />
        </Stack>
      )}
    </Stack>
  );
}

function WattHourTab({ measurement }: { measurement: MeasurementSummary }) {
  const measurements = useMeasurements();
  const isCurrentPrimary = isCurrentUnit(measurement.unit);

  const [otherId, setOtherId] = useState<string | null>(null);
  const [defaultValue, setDefaultValue] = useState<number | string>("");
  const [createDataset, setCreateDataset] = useState(false);

  const calculateWattHour = useCalculateWattHour();
  const [result, setResult] = useState<WattHourResponse | null>(null);

  const otherOptions = (measurements.data ?? [])
    .filter((m) => m.id !== measurement.id)
    .filter((m) => (isCurrentPrimary ? isVoltageUnit(m.unit) : isCurrentUnit(m.unit)))
    .map((m) => ({ value: m.id, label: m.name }));

  const defaultNumeric = toNumber(defaultValue);
  const hasDefault = Number.isFinite(defaultNumeric);

  function handleCalculate() {
    const body = isCurrentPrimary
      ? {
          current_measurement_id: measurement.id,
          voltage_measurement_id: otherId,
          default_voltage: otherId ? null : hasDefault ? defaultNumeric : null,
          create_dataset: createDataset,
        }
      : {
          voltage_measurement_id: measurement.id,
          current_measurement_id: otherId,
          default_current: otherId ? null : hasDefault ? defaultNumeric : null,
          create_dataset: createDataset,
        };
    calculateWattHour.mutate(body, { onSuccess: setResult });
  }

  const canCalculate = !!otherId || hasDefault;

  return (
    <Stack gap="sm" pt="sm">
      <Text size="sm" c="dimmed">
        This is the <Text span fw={700}>{isCurrentPrimary ? "current" : "voltage"}</Text> dataset. Pick a{" "}
        {isCurrentPrimary ? "voltage" : "current"} measurement, or enter a constant{" "}
        {isCurrentPrimary ? "voltage" : "current"} for this dataset.
      </Text>
      <Select
        size="xs"
        placeholder={`Select a ${isCurrentPrimary ? "voltage" : "current"} measurement`}
        data={otherOptions}
        value={otherId}
        onChange={setOtherId}
        clearable
      />
      <NumberInput
        size="xs"
        label={`Default ${isCurrentPrimary ? "voltage (V)" : "current (A)"} if no measurement selected`}
        disabled={!!otherId}
        value={defaultValue}
        onChange={setDefaultValue}
      />
      <Checkbox
        label="Create dataset for calculated measurement (power, W)"
        checked={createDataset}
        onChange={(e) => setCreateDataset(e.currentTarget.checked)}
      />
      <Group>
        <Button size="xs" loading={calculateWattHour.isPending} disabled={!canCalculate} onClick={handleCalculate}>
          Calculate
        </Button>
      </Group>
      {calculateWattHour.isError && (
        <Alert color="red" title="Calculation failed">
          {(calculateWattHour.error as Error).message}
        </Alert>
      )}
      {result && (
        <Stack gap="sm">
          <HeadlineResult label="Watt-hour" value={result.watt_hour_value} unit="Wh" />
          <StatsRows stats={result.stats} unit="W" />
          {result.created_measurement_id && (
            <Text size="xs" c="dimmed">
              Saved as a new calculated measurement — find it in the Stored browser.
            </Text>
          )}
        </Stack>
      )}
    </Stack>
  );
}

function ShuntCurrentTab({ measurement }: { measurement: MeasurementSummary }) {
  const [resistance, setResistance] = useState<number | string>("");
  const [store, setStore] = useState(false);
  const calculateShuntCurrent = useCalculateShuntCurrent();
  const [result, setResult] = useState<ShuntCurrentResponse | null>(null);

  const resistanceNumeric = toNumber(resistance);
  const validResistance = Number.isFinite(resistanceNumeric) && resistanceNumeric > 0;

  return (
    <Stack gap="sm" pt="sm">
      <Text size="sm" c="dimmed">
        This dataset is a voltage measured over a shunt resistor. Fill in the shunt value in ohm to calculate the
        current.
      </Text>
      <NumberInput
        size="xs"
        label="Shunt resistance (Ω)"
        min={0}
        value={resistance}
        onChange={setResistance}
      />
      <Stack gap={2}>
        <Checkbox
          label="Store as new calculated measurement (current, A)"
          checked={store}
          onChange={(e) => setStore(e.currentTarget.checked)}
        />
        <Text size="xs" c="dimmed" pl={28}>
          This allows the calculated measurement to be shown in a chart
        </Text>
      </Stack>
      <Group>
        <Button
          size="xs"
          loading={calculateShuntCurrent.isPending}
          disabled={!validResistance}
          onClick={() =>
            calculateShuntCurrent.mutate(
              { voltage_measurement_id: measurement.id, resistance_ohms: resistanceNumeric, store },
              { onSuccess: setResult },
            )
          }
        >
          Calculate
        </Button>
      </Group>
      {calculateShuntCurrent.isError && (
        <Alert color="red" title="Calculation failed">
          {(calculateShuntCurrent.error as Error).message}
        </Alert>
      )}
      {result && (
        <Stack gap="sm">
          <Text size="sm" c="dimmed" ta="center">
            Calculated {result.points.length} points
          </Text>
          <StatsRows stats={result.stats} unit="A" />
          {result.created_measurement_id && (
            <Text size="xs" c="dimmed">
              Saved as a new calculated measurement — view it as a chart via the Stored browser.
            </Text>
          )}
        </Stack>
      )}
    </Stack>
  );
}

// General Ohm's-law transform (U = I x R): the measurement's own unit fixes
// the "primary" quantity; the user picks which of the *other* two is held
// constant and supplies its value -- unlike Watt-hour, there's no second-
// measurement option here, just a constant (Changes ausgust-25.txt item 11).
function OhmsLawTab({ measurement, primary }: { measurement: MeasurementSummary; primary: OhmsLawQuantity }) {
  const otherQuantities = (["V", "I", "R"] as OhmsLawQuantity[]).filter((q) => q !== primary);
  const [constantQuantity, setConstantQuantity] = useState<OhmsLawQuantity>(otherQuantities[0]);
  const [constantValue, setConstantValue] = useState<number | string>("");
  const [createDataset, setCreateDataset] = useState(false);
  const calculateOhmsLaw = useCalculateOhmsLaw();
  const [result, setResult] = useState<OhmsLawResponse | null>(null);

  const constantNumeric = toNumber(constantValue);
  const canCalculate = Number.isFinite(constantNumeric);

  return (
    <Stack gap="sm" pt="sm">
      <Text size="sm" c="dimmed">
        The measurement has unit {OHMS_LAW_UNIT_NAME[primary]}. Select the quantity that is constant and its value.
      </Text>
      <Radio.Group
        value={constantQuantity}
        onChange={(v) => setConstantQuantity(v as OhmsLawQuantity)}
        label="Constant quantity"
        size="xs"
      >
        <Group gap="md" mt={4}>
          {otherQuantities.map((q) => (
            <Radio key={q} value={q} label={OHMS_LAW_FIELD_LABEL[q]} size="xs" />
          ))}
        </Group>
      </Radio.Group>
      <NumberInput
        size="xs"
        label={`Constant ${OHMS_LAW_FIELD_LABEL[constantQuantity]} (${OHMS_LAW_UNIT_SUFFIX[constantQuantity]})`}
        value={constantValue}
        onChange={setConstantValue}
      />
      <Checkbox
        label="Create dataset for calculated measurement"
        checked={createDataset}
        onChange={(e) => setCreateDataset(e.currentTarget.checked)}
      />
      <Group>
        <Button
          size="xs"
          loading={calculateOhmsLaw.isPending}
          disabled={!canCalculate}
          onClick={() =>
            calculateOhmsLaw.mutate(
              {
                measurement_id: measurement.id,
                constant_quantity: constantQuantity,
                constant_value: constantNumeric,
                create_dataset: createDataset,
              },
              { onSuccess: setResult },
            )
          }
        >
          Calculate
        </Button>
      </Group>
      {calculateOhmsLaw.isError && (
        <Alert color="red" title="Calculation failed">
          {(calculateOhmsLaw.error as Error).message}
        </Alert>
      )}
      {result && (
        <Stack gap="sm">
          <Text size="sm" c="dimmed" ta="center">
            Calculated {result.points.length} points
          </Text>
          <StatsRows stats={result.stats} unit={result.output_unit} />
          {result.created_measurement_id && (
            <Text size="xs" c="dimmed">
              Saved as a new calculated measurement — view it as a chart via the Stored browser.
            </Text>
          )}
        </Stack>
      )}
    </Stack>
  );
}

interface CalculationModalProps {
  measurement: MeasurementSummary;
  onClose: () => void;
}

export function CalculationModal({ measurement, onClose }: CalculationModalProps) {
  const isCurrent = isCurrentUnit(measurement.unit);
  const isVoltage = isVoltageUnit(measurement.unit);
  const isResistance = isResistanceUnit(measurement.unit);
  // The Ohm's-law tab applies to any of the three -- unlike Ah (current-only)
  // and Shunt-current (voltage-only), it's never disabled once reachable.
  const ohmsLawQuantity: OhmsLawQuantity | null = isVoltage ? "V" : isCurrent ? "I" : isResistance ? "R" : null;
  const [tab, setTab] = useState<string | null>(
    isCurrent ? "ah" : isVoltage ? "watt-hour" : isResistance ? "ohms-law" : null,
  );

  return (
    <Modal opened onClose={onClose} title="Calculate" size="md">
      {!ohmsLawQuantity ? (
        <Text size="sm" c="dimmed">
          No calculations are available for unit "{measurement.unit}" — these all require a current, voltage, or
          resistance dataset.
        </Text>
      ) : (
        <Tabs value={tab} onChange={setTab}>
          <Tabs.List>
            <Tabs.Tab value="ah" disabled={!isCurrent}>
              Ah
            </Tabs.Tab>
            <Tabs.Tab value="watt-hour" disabled={isResistance}>
              Watt-hour (Wh)
            </Tabs.Tab>
            <Tabs.Tab value="shunt-current" disabled={!isVoltage}>
              Shunt-current
            </Tabs.Tab>
            <Tabs.Tab value="ohms-law">{OHMS_LAW_TAB_LABEL[ohmsLawQuantity]}</Tabs.Tab>
          </Tabs.List>
          <Tabs.Panel value="ah">{isCurrent && <AhTab measurement={measurement} />}</Tabs.Panel>
          <Tabs.Panel value="watt-hour">{!isResistance && <WattHourTab measurement={measurement} />}</Tabs.Panel>
          <Tabs.Panel value="shunt-current">
            {isVoltage && <ShuntCurrentTab measurement={measurement} />}
          </Tabs.Panel>
          <Tabs.Panel value="ohms-law">
            <OhmsLawTab measurement={measurement} primary={ohmsLawQuantity} />
          </Tabs.Panel>
        </Tabs>
      )}
    </Modal>
  );
}

export function CalculatedBadge({ measurement }: { measurement: MeasurementSummary }) {
  const colorScheme = useComputedColorScheme("light");
  if (measurement.kind !== "calculated") return null;
  return (
    <Badge size="xs" style={chipStyle(CHIP_HUES.calculated, colorScheme)}>
      Calculated
    </Badge>
  );
}
