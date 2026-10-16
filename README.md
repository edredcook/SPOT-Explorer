# SPOT Explorer

A public, read-only explorer for the released SPOT MFA V1.4.1-G-0426 baseline results for model year 2020. Maps, country relationships, profiles and comparisons occupy separate analysis tabs. All views use the saved release; this stage does not run the model or accept uploaded data.

## Run locally

Use Python 3.12. From this project folder on Windows:

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe -m unittest discover -s tests -v
.\.venv\Scripts\python.exe -m flask --app app run --host 127.0.0.1 --port 5000
```

Open <http://127.0.0.1:5000>. On macOS/Linux, replace `.\.venv\Scripts\python.exe` with `.venv/bin/python`. Gunicorn is installed on Linux/macOS for deployment; Windows uses Flask's local development server. Local development mode is not the public hosting configuration.

## Deploy to Render

1. Put **this folder's contents** in a GitHub repository, with `app.py`, `requirements.txt` and `render.yaml` at the repository root. Do not upload the parent research folder, original large workbooks, private handovers or `.venv`.
2. In Render, create a **Blueprint** and connect that repository. Select `render.yaml`. Review the generated `spot-explorer` web service and create it.
3. The blueprint installs the pinned dependencies, starts `gunicorn app:app`, and uses `/healthz` for readiness. It requests a free web-service plan and no database or persistent disk.
4. Enable GitHub Actions for the repository. The supplied workflow checks the public API, data/export contracts and a Linux Gunicorn smoke test. Automatic deployments use Render's `checksPass` trigger. Ensure the deployment branch has the verification workflow enabled.
5. After the initial deploy, open the Render service URL and verify a country profile, a comparison, a CSV download and the provenance panel. Check `/healthz` and `/api/provenance` directly.

If this app is kept inside a larger repository instead, configure the Render service root directory and workflow working directory accordingly. The supplied files assume a dedicated repository root. Domain setup and service creation happen in the hosting account; these files do not create a remote service by themselves.

## Public API

All routes are read-only. Invalid selectors, unknown query arguments and repeated query arguments return HTTP 400 with `{"error":{"code":"invalid_query","message":"..."}}`.

| Route | Purpose |
| --- | --- |
| `/healthz` | Readiness status |
| `/api/meta` | Release, entities, metric definitions, units and statistics |
| `/api/profile?entity=IND` | One entity's country profile |
| `/api/map?basis=total&statistic=Mean` | All national plastic-emissions values and their released 5th/median/95th summaries |
| `/api/atlas?statistic=Mean` | All national entity metadata and all 68 released output metrics, with mean, median and 5th/95th summaries |
| `/api/compare?entities=IND,GBR&metric=plas_em&family=outputs&statistic=Mean` | Selected values and their released 5th/median/95th summaries |
| `/api/download` | CSV for the same selectors as comparison |
| `/api/snapshot?entity=IND` | Downloadable JSON country snapshot |
| `/api/provenance` | Source and derived-file provenance manifest |

Profile and snapshot default to `IND`. Comparison and CSV default to entities `IND,CHN,USA`, metric `plas_em`, family `outputs`, statistic `Mean`. CSV includes release, model year, entity identity, family, metric, statistic, value and unit. JSON represents unavailable values as `null`; CSV uses an empty value field. Known zero values remain `0`.

Map selectors are `basis=total|per_capita` and `statistic=Mean|Median`; defaults are `total` and `Mean`. Total emissions use the released `plas_em` output in tonnes/year. Per-person emissions use the separate released `plas_em_per_cap` output in kg/person/year, including its own uncertainty summaries. Map requests return national entities only; regional and world profiles remain available through the country search. The map changes the linked country profile when a user selects a shape or a country in its values table.

The atlas API accepts only `statistic=Mean|Median`, defaulting to Mean. Each row retains the released entity metadata and a `values` object keyed by output ID. Each metric contains `value`, `mean`, `median`, `low` and `high`; none is recalculated from another metric. This supplies the map concepts and country relationship charts without transferring the full research workbook to the browser.

## Analysis views

- **Country shading:** a single metric, including native per-person rates and percentages.
- **Proportional circles:** one circle per SPOT reporting entity; circle area follows its value. Multipart countries do not produce repeated statistical observations.
- **Emission composition:** country pies split mean plastic emissions into debris and openly burned plastic. Pie area follows the selected total or native per-person amount. This view uses means because marginal medians and percentiles do not generally add to the median or percentile of a total.
- **Collection and emissions:** a nine-colour map combines country thirds of collection service coverage and plastic emissions per person. Numeric class bounds appear in the key. These are display groups, not performance targets or significance tests.
- **Relationships:** selectable country scatterplots, income/region filters, exact source units, log axes, area-scaled bubbles, source-value tooltips and a numerical table/CSV. Presets compare collection with emissions, plastic generation with emissions, debris with burning, and total emissions with emissions per person.

These views describe cross-sectional model results for 2020. They do not provide a trend or independent evidence of causation. Associations can reflect shared model inputs and model structure. Waste-generation rates retain their native kg/person/day units; emission rates retain kg/person/year. No time sequence or annualisation is invented for display. Region and income labels remain the classifications supplied with this release; the classification year of its output income labels is not stated.

Further views supported by the release include five-source emission fingerprints (`plas_litter_em`, `plas_uncol_em`, `plas_collection_em`, `plas_disp_em`, `plas_recy_em` means), rigid/flexible plastic-format comparisons, people without collection (`people_no_col`), and a derived relative 5th–95th interval width. An interval-width view would show modelled dispersion, not accuracy or a confidence score. Rigid/flexible labels describe plastic formats, not polymer categories. These are concepts for subsequent views, rather than additional outputs of this revision.

The map selection follows [Datawrapper's map guidance (2018)](https://www.datawrapper.de/blog/choroplethmaps): rate-based shading, symbols for absolute quantities, and scatterplots to inspect relationships. The concepts are implemented locally using the existing source bundle and map geometry.

The 5th and 95th values describe the released Monte Carlo summaries. The mean can fall outside that interval in a skewed distribution; it is not an error bound around the selected statistic. Summaries must not be added to invent new regional uncertainty intervals. Use the released regional/global results where available.

## Data and attribution

The original released estimates are from Cottom, Cook and Velis (2026), *SPOT model - MFA Version 1.4.1-G-0426* ([dataset DOI](https://doi.org/10.5281/zenodo.22231994)). The methodology is described by Cottom, Cook and Velis (2024), *A local-to-global emissions inventory of macroplastic pollution* ([Nature paper](https://doi.org/10.1038/s41586-024-07758-6)). Retain the source citation, model year, units and version when reusing downloads. See `LICENSE` for the supplied CC BY 4.0 attribution notice and third-party-source qualifications.

The explorer reads its packaged data relative to `app.py`, rather than relying on the launch directory. Its provenance manifest records the release source and hashes. It must not contain workstation paths, credentials or private review material. Preserve the current release files when adding a new release; update the manifest and run the checks before switching the website to new data.

`tools/prepare_data.py --source-root PATH --output data` rebuilds the derived bundle from a complete local release folder. It requires `openpyxl` in the **preparation environment**; the website runtime does not need it. Treat this as an explicit release-maintenance action because it replaces the packaged bundle. The source workbook comparison in `tests/test_data.py` runs when `openpyxl` and the sibling `MFA_V1.4.1-G-0426` source folder are available; it is skipped in a standalone deployment. The remaining checks verify the packaged release identity, hashes, numeric identities, quantiles and API/export behavior without the original research archive.

### Map boundaries

The map uses [Natural Earth Admin 0 map units, version 5.1.1](https://www.naturalearthdata.com/downloads/50m-cultural-vectors/50m-admin-0-details/) (year not stated; retrieved 15 October 2026), with 50m-scale boundaries and selected 10m-scale supplements for small territories. Natural Earth permits redistribution and modification under its [public-domain terms](https://www.naturalearthdata.com/about/terms-of-use/) (year not stated). The display layer matches all 246 SPOT reporting entities; a national estimate may colour several shapes and must not be added once per shape. The source's de facto boundaries are a display aid, not a reconstruction of the model's municipal geometry.

`web/assets/map_manifest.json` records source archive URLs and hashes, the prepared geometry hashes, the unchanged statistical bundle hash and mapping qualifications. `map_crosswalk.json` retains every source feature's match or neutral-background status and explicit overrides for SPOT's native keys. `python tools/prepare_map.py` reproduces these assets with the Python standard library and pinned source hashes; raw source archives stay under ignored `qa-artifacts/map-source/`. The hashed JSON/GeoJSON files are marked `-text` in `.gitattributes` to preserve their exact bytes on Windows and Linux. The winding convention is retained for D3's spherical rendering and documented in the manifest.

## Maintenance boundary

The site serves saved baseline data. It has no project accounts, upload service, model execution worker or shared-data submissions. Those capabilities require a separately versioned service. Review numerical model changes separately from this explorer so that the displayed release remains traceable.

## Interface style

The 15 October 2026 map revision follows the supplied SHAPE Foundation brand guidelines (November 2025, typography and colour pages 17–19) and the reviewed COP31-MFA chart controls. Poppins is served locally, with Arial and sans serif fallbacks. The interface uses dark teal, cream, turquoise and amber from that reference while retaining SPOT's own name and identity. Font and D3 licence notices are packaged beside the local assets under `web/vendor/`.

The zoom slider changes the map view only. The source release contains one modelled year, 2020, so the interface does not interpolate a time series. Country searches and the numerical map table provide alternatives to pointer interaction and access to reporting entities without a displayed boundary. Numerical estimates, units and missing values are independent of the colour scale and zoom level.

On 16 October 2026, Ed requested a content-first analysis workspace: no straplines, promotional headlines or decorative footnotes; one analysis at a time in tabs, following the COP31-MFA arrangement. Plain chart titles, metric labels, years and units remain visible. Methods, sources and detailed qualifications stay in dedicated dialogs or data views. The separate Sankey concept can become another analysis tab when its data contract and implementation are ready.

Implementation references checked 15 October 2026: [Flask 3.1.3](https://pypi.org/project/Flask/3.1.3/), [Gunicorn 26.2.0](https://pypi.org/project/gunicorn/26.2.0/), [Render Blueprint specification](https://render.com/docs/blueprint-spec), [GitHub checkout](https://github.com/actions/checkout), [GitHub setup-python](https://github.com/actions/setup-python).
