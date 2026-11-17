# Evidence for published results

Raw output behind the numbers quoted in the README and in public posts. Everything else that the benchmark scripts
write is not committed; run the scripts to regenerate it.

| Folder | Result | Described in |
| --- | --- | --- |
| `incident/` | Injected database bug: alert webhook at +38 s, monitor in Alert at +40 s, failing query and logs found; recovery | `bench/incident/README.md` |
| `correctness/` | 36/36 data-correctness checks (run `p2fpk9`) | `bench/correctness/README.md` |
| `alerts/` | Alert reliability, 15 checks per run: run 1 14/15 (before a fix), runs 2 and 3 15/15 | `bench/resilience/README.md` |
| `soak-3h/` | 3-hour soak: 26,056,846 spans and 4,399,585 logs sent and stored, 0 lost; per-minute samples and UI query probes | `bench/soak/README.md` |
| `recovery/` | Failure recovery after the exporter fix (backend outage, database restart, agent restart) | `bench/resilience/README.md` |

All runs were on one 4-vCPU test VM with Postgres storage.
