'use client';

/**
 * Event log console (docs/Frontend-Design §16) — monospace engineering
 * console with severity filter, follow-tail, clear. Throttled rendering
 * via the store flush.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Download, Pause, Play, Trash2 } from 'lucide-react';
import { useFsoc } from '@/lib/store';
import type { LogLevel } from '@/engine/types';
import { Button } from '@/components/ui/button';

const LEVEL_COLOR: Record<LogLevel, string> = {
  INFO: '#7d8994',
  DETECT: '#72d9e8',
  STATE: '#8faee8',
  METRIC: '#79c99b',
  DIST: '#d8b56b',
  TRACK: '#d7b36e',
  WARN: '#d8b56b',
  ERROR: '#d87575',
};

const FILTERS: (LogLevel | 'ALL')[] = ['ALL', 'STATE', 'METRIC', 'DETECT', 'DIST', 'WARN', 'ERROR'];

export function EventLog() {
  const logs = useFsoc((s) => s.logs);
  const [filter, setFilter] = useState<LogLevel | 'ALL'>('ALL');
  const [follow, setFollow] = useState(true);
  const [query, setQuery] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);

  const filtered = useMemo(
    () =>
      logs.filter(
        (l) =>
          (filter === 'ALL' || l.level === filter) &&
          (query === '' ||
            l.message.toLowerCase().includes(query.toLowerCase()) ||
            (l.detail ?? '').toLowerCase().includes(query.toLowerCase())),
      ),
    [logs, filter, query],
  );

  useEffect(() => {
    if (follow && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [filtered.length, follow]);

  const exportLogs = () => {
    const text = logs.map((l) => `${l.t}  ${l.level.padEnd(6)} ${l.message}${l.detail ? `  ${l.detail}` : ''}`).join('\n');
    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `fsoc-pat-events-${Date.now()}.log`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="panel h-full flex flex-col min-h-0">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-fsoc-border1">
        <span className="panel-title">Event Log</span>
        <div className="flex-1" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="search…"
          className="h-6 w-32 bg-fsoc-bg0 border border-fsoc-border1 rounded px-2 text-[10px] text-fsoc-text1 placeholder:text-fsoc-text3 focus:outline-none focus:border-fsoc-cyan/50"
        />
        <div className="flex gap-0.5">
          {FILTERS.map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`px-1.5 py-0.5 rounded text-[9px] tracking-wider transition-colors ${
                filter === f ? 'bg-fsoc-bg3 text-fsoc-cyan' : 'text-fsoc-text3 hover:text-fsoc-text2'
              }`}
            >
              {f}
            </button>
          ))}
        </div>
        <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => setFollow((f) => !f)} title={follow ? 'Follow tail (on)' : 'Follow tail (off)'}>
          {follow ? <Pause className="w-3 h-3" /> : <Play className="w-3 h-3" />}
        </Button>
        <Button variant="ghost" size="icon" className="h-6 w-6" onClick={exportLogs} title="Export log">
          <Download className="w-3 h-3" />
        </Button>
        <Button variant="ghost" size="icon" className="h-6 w-6 text-fsoc-text3" onClick={() => useFsoc.setState({ logs: [] })} title="Clear">
          <Trash2 className="w-3 h-3" />
        </Button>
      </div>
      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto px-3 py-2 font-mono text-[10.5px] leading-[1.7]">
        {filtered.length === 0 ? (
          <div className="text-fsoc-text3">No events {filter !== 'ALL' ? `for filter ${filter}` : 'yet'}.</div>
        ) : (
          filtered.slice(-160).map((l) => (
            <div key={l.id} className="flex gap-3 whitespace-nowrap">
              <span className="text-fsoc-text3 shrink-0">{l.t}</span>
              <span className="shrink-0 w-12" style={{ color: LEVEL_COLOR[l.level] }}>
                {l.level}
              </span>
              <span className="text-fsoc-text1 truncate">{l.message}</span>
              {l.detail && <span className="text-fsoc-text3 truncate">{l.detail}</span>}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
