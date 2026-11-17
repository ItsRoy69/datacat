import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

export interface TimeRange {
  label: string;
  seconds?: number;
  from?: number;
  to?: number;
}
export const PRESETS: TimeRange[] = [
  { label: "Past 5 Minutes", seconds: 300 },
  { label: "Past 15 Minutes", seconds: 900 },
  { label: "Past 1 Hour", seconds: 3600 },
  { label: "Past 4 Hours", seconds: 14400 },
  { label: "Past 1 Day", seconds: 86400 },
  { label: "Past 2 Days", seconds: 172800 },
  { label: "Past 1 Week", seconds: 604800 },
];
export const SHORT: Record<string, string> = {
  "Past 5 Minutes": "5m",
  "Past 15 Minutes": "15m",
  "Past 1 Hour": "1h",
  "Past 4 Hours": "4h",
  "Past 1 Day": "1d",
  "Past 2 Days": "2d",
  "Past 1 Week": "1w",
};

interface Ctx {
  range: TimeRange;
  setRange: (r: TimeRange) => void;
  live: boolean;
  setLive: (b: boolean) => void;
  tick: number;
  from: number;
  to: number;
  refresh: () => void;
}
const TimeCtx = createContext<Ctx | null>(null);

export function TimeProvider({ children, initial = PRESETS[2] }: { children: ReactNode; initial?: TimeRange }) {
  const [range, setRange] = useState<TimeRange>(initial);
  const [live, setLive] = useState(true);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!live || !range.seconds) return;
    const iv = setInterval(() => setTick((t) => t + 1), range.seconds <= 900 ? 10_000 : 30_000);
    return () => clearInterval(iv);
  }, [live, range]);
  const { from, to } = useMemo(() => {
    if (range.seconds) {
      const to = Math.floor(Date.now() / 1000);
      return { from: to - range.seconds, to };
    }
    return { from: range.from!, to: range.to! };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range, tick]);
  return <TimeCtx.Provider value={{ range, setRange, live, setLive, tick, from, to, refresh: () => setTick((t) => t + 1) }}>{children}</TimeCtx.Provider>;
}
export function useTime() {
  const c = useContext(TimeCtx);
  if (!c) throw new Error("TimeProvider missing");
  return c;
}
