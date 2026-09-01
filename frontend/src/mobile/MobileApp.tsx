import { useEffect, useState } from "react";
import { Center, Loader, useComputedColorScheme } from "@mantine/core";

import { ApiError, getMobileToken, setMobileToken } from "../api/client";
import { useDevices } from "../api/devices";
import { MobileDevicePicker } from "./MobileDevicePicker";
import { MobileDeviceView } from "./MobileDeviceView";
import { MobilePinGate } from "./MobilePinGate";

type Stage = "checking" | "pin" | "app";

export function MobileApp() {
  // A remembered token (Mobile Requirements.txt item 2.2) is tried
  // optimistically -- "checking" fetches the device list once to confirm it's
  // still valid; a 401 falls back to the PIN screen and forgets the stale
  // token, anything else means it's good and we go straight to the app.
  const [stage, setStage] = useState<Stage>(getMobileToken() ? "checking" : "pin");
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const devices = useDevices();
  const colorScheme = useComputedColorScheme("light");

  useEffect(() => {
    if (stage !== "checking") return;
    if (devices.isSuccess) {
      setStage("app");
    } else if (devices.isError && devices.error instanceof ApiError && devices.error.status === 401) {
      setMobileToken(null);
      setStage("pin");
    }
  }, [stage, devices.isSuccess, devices.isError, devices.error]);

  // White for light, near-black for dark -- driven by useComputedColorScheme,
  // which a hardcoded-white test round confirmed actually renders correctly
  // on both the PC browser and mobile Chrome (both showed exactly the
  // hardcoded value, proving this div's background genuinely controls what's
  // displayed). Samsung Internet showing dark regardless is a separate,
  // browser-level "dark mode for website content" setting on that browser
  // specifically -- not something this page's own code can override, the
  // same class of issue as Chrome's "force dark for web contents".
  const pageBg = colorScheme === "dark" ? "#020508" : "#ffffff";

  return (
    <div style={{ minHeight: "100vh", backgroundColor: pageBg }}>
      {stage === "checking" && (
        <Center h="100vh">
          <Loader />
        </Center>
      )}
      {stage === "pin" && <MobilePinGate onSuccess={() => setStage("app")} />}
      {stage === "app" && deviceId && <MobileDeviceView deviceId={deviceId} onBack={() => setDeviceId(null)} />}
      {stage === "app" && !deviceId && <MobileDevicePicker onSelect={setDeviceId} />}
    </div>
  );
}
