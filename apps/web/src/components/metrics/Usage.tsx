import { useMemo } from "react";
import { formatBytes } from "../../lib/metrics";
import { formatPercent, usageSummary } from "../../lib/metrics";
import { useNow } from "../../hooks/useNow";
import { useMetricsStore } from "../../stores/metricsStore";
import { CPU_COLOR, MEM_COLOR } from "../../lib/metricColors";
import { useT } from "../../lib/i18n";
import { Spark } from "../../ui/shared/atoms";

/**
 * The cost panel: CPU and memory for the watched scope, as one row of labels
 * and one row of figures, in the shared `mon-*` vocabulary.
 *
 *   CPU        <the process being watched>        MEM
 *   0.30% avg 0.37%                          252 MB peak 292
 *
 * The label row names the *scope* in the middle, because the two figures are
 * whatever that scope is: the whole agent by default, one egg when one is
 * selected. Putting the name between them is what makes "CPU" and "MEM" mean
 * something without a second caption line.
 *
 * The figure is one line, not three: the current value in its metric's colour,
 * the secondary value beside it in small grey. `cores` and `host` were dropped
 * — a rail this narrow is read at a glance, and "0.00 cores" beside "0.30%"
 * says the same thing twice in different units.
 *
 * This is a shared component, not an export of MonitorRight: Monitor's rail
 * and Rounds' eggs window both render it, and the derivation behind it lives
 * in `lib/metrics` (`usageSummary`), not here.
 */
export function Usage() {
  const t = useT();
  const version = useMetricsStore((s) => s.version);
  const selectedEggPid = useMetricsStore((s) => s.selectedEggPid);
  const frames = useMetricsStore.getState().frames;
  const now = useNow(2000);

  const { cores, avgCores, memMiB, peakMiB, cpuSpark, memSpark, cpuCount, scope } = useMemo(
    () => usageSummary(frames, selectedEggPid),
    // `version` marks ring writes and `now` keeps the averages ticking between
    // frames — the derivation itself reads only `frames`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [frames, version, now, selectedEggPid],
  );

  const name = scope ?? t("Agent");

  return (
    <div className="mon-met">
      <div className="mon-met__head">
        <span>{t("CPU")}</span>
        <span className="mon-met__name" title={name}>
          {name}
        </span>
        <span>{t("MEM")}</span>
      </div>

      <div className="mon-met__row">
        <div className="mon-met__cell">
          <b style={{ color: CPU_COLOR }}>
            {frames.length === 0 ? "—" : formatPercent((cores / Math.max(1, cpuCount)) * 100)}
          </b>
          {frames.length === 0 ? (
            <small>{t("Waiting for the first sample…")}</small>
          ) : (
            <small>
              {t("avg")} {formatPercent((avgCores / Math.max(1, cpuCount)) * 100)}
            </small>
          )}
          {frames.length > 0 ? <Spark values={cpuSpark} tone="run" /> : null}
        </div>

        <div className="mon-met__cell mon-met__cell--end">
          <b style={{ color: MEM_COLOR }}>
            {frames.length === 0 ? "—" : formatBytes(memMiB * 1024 * 1024)}
          </b>
          {frames.length === 0 ? <small>&nbsp;</small> : <small>{`${t("peak")} ${Math.round(peakMiB)}`}</small>}
          {frames.length > 0 ? <Spark values={memSpark} tone="read" /> : null}
        </div>
      </div>
    </div>
  );
}
