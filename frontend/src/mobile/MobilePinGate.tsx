import { useState } from "react";
import { Alert, Center, Loader, PinInput, Stack, Text, Title } from "@mantine/core";

import { useMobileEnabled, useVerifyPin } from "../api/mobile";

export function MobilePinGate({ onSuccess }: { onSuccess: () => void }) {
  const enabled = useMobileEnabled();
  const verifyPin = useVerifyPin();
  const [pin, setPin] = useState("");

  function handleComplete(value: string) {
    verifyPin.mutate(value, {
      onSuccess,
      onError: () => setPin(""),
    });
  }

  if (enabled.isLoading) {
    return (
      <Center h="100vh">
        <Loader />
      </Center>
    );
  }

  if (enabled.data && !enabled.data.enabled) {
    return (
      <Center h="100vh" p="md">
        <Stack align="center" gap="xs" maw={320}>
          <Title order={3} ta="center">
            Mobile access isn't enabled
          </Title>
          <Text c="dimmed" ta="center" size="sm">
            Set a PIN on the PC dashboard's Settings page (Mobile access) to turn this on.
          </Text>
        </Stack>
      </Center>
    );
  }

  return (
    <Center h="100vh" p="md">
      <Stack align="center" gap="md">
        <img src="/logo.svg" alt="" width={56} height={56} />
        <Stack align="center" gap={2}>
          <Title order={3}>Welcome to OWON Mobile</Title>
          <Text c="dimmed" size="sm">
            Enter the PIN set on the PC dashboard
          </Text>
        </Stack>
        <PinInput
          length={4}
          type="number"
          value={pin}
          onChange={setPin}
          onComplete={handleComplete}
          size="xl"
          autoFocus
          disabled={verifyPin.isPending}
          mask
        />
        {verifyPin.isError && (
          <Alert color="red" title="Couldn't verify PIN">
            {(verifyPin.error as Error).message}
          </Alert>
        )}
      </Stack>
    </Center>
  );
}
