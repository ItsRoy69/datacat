import { useState } from "react";
import { Pause, Play, RefreshCw, ChevronDown } from "lucide-react";
import { PRESETS, SHORT, useTime } from "@/lib/time";

export function TimePicker() {
  const { range, setRange, live, setLive, refresh } = useTime();
  const [open, setOpen] = useState(false);
  return (
    <div className="flex items-center gap-1 relative">
      <button className="btn !pl-1 !pr-2 min-w-[200px]" onClick={() => setOpen(!open)} data-testid="time-picker">
        <span className="inline-flex items-center justify-center h-[20px] px-1.5 rounded-[3px] bg-[#e9ebf0] text-[11px] font-semibold text-ink-2">
          {SHORT[range.label] ?? "Custom"}
        </span>
        <span className="flex-1 text-left">{range.label}</span>
        <ChevronDown size={14} className="text-ink-3" />
      </button>
      <div className="flex">
        <button className="btn !px-2 !rounded-r-none" title={live ? "Pause live updates" : "Resume live updates"} onClick={() => setLive(!live)}>
          {live ? <Pause size={14} /> : <Play size={14} />}
        </button>
        <button className="btn !px-2 !rounded-l-none -ml-px" title="Refresh" onClick={refresh}>
          <RefreshCw size={14} />
        </button>
      </div>
      {open && (
        <div className="absolute right-0 top-9 w-56 card shadow-lg py-1 z-50">
          {PRESETS.map((p) => (
            <button
              key={p.label}
              onClick={() => {
                setRange(p);
                setOpen(false);
              }}
              className={`w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-[#f2f4fb] ${p.label === range.label ? "text-primary font-semibold" : ""}`}
            >
              <span className="chip w-9 justify-center">{SHORT[p.label]}</span> {p.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
