# data

- `retirement-series.json` - series id, size-name regex, retirement date (source: docs/research.md section 1). First match wins; flag-only series (GPU/HPC) have no mapping.
- `sku-mapping.json` - target templates (`{vcpu}` placeholder) per size group, ranked v7 > v6 > optional v5, AMD before Intel; `tempDisk` marks `d` sizes. Names are guidance only - the Resource SKUs API is authoritative (checked by pre-checks).

Set `VMM_DATA_DIR` to use another catalog directory.
