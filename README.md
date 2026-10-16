# SPOT Explorer

A public, read-only explorer for the released SPOT MFA V1.4.1-G-0426 baseline results for model year 2020. Maps, five-source profiles, rankings, relationships, country details and comparisons occupy separate analysis tabs. All views use the saved release; this stage does not run the model or accept uploaded data. Invitation-only accounts are separate from public chart access.

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
3. The blueprint installs the pinned dependencies, prepares the private municipal map asset, starts `gunicorn app:app` with **one worker and four threads**, and uses `/healthz` for readiness. The first build selectively downloads the municipal GIS member from Zenodo and can take several minutes. It requests a free web-service plan and no database or persistent disk. An existing manually configured Render service must use the same build command and one worker: account tokens live in a bounded server-side memory vault, which is not shared across workers.
4. Enable GitHub Actions for the repository. The supplied workflow checks the public API, data/export contracts and a Linux Gunicorn smoke test. Automatic deployments use Render's `checksPass` trigger. Ensure the deployment branch has the verification workflow enabled.
5. After the initial deploy, open the Render service URL and verify a country profile, a comparison, a CSV download and the provenance panel. Check `/healthz` and `/api/provenance` directly.

If this app is kept inside a larger repository instead, configure the Render service root directory and workflow working directory accordingly. The supplied files assume a dedicated repository root. Domain setup and service creation happen in the hosting account; these files do not create a remote service by themselves.

## Invitation-only accounts

The `/account` interface provides sign-in, invitation activation, password recovery and owner-only invitation management. Public charts, data tables and exports remain open. This account layer does not yet store projects or run the model.

Configure these **server-side Render environment variables**, using the existing Supabase authentication project:

- `SPOT_SUPABASE_URL`: the project's HTTPS origin.
- `SPOT_SUPABASE_PUBLISHABLE_KEY`: the publishable key (legacy anon key is also supported).
- `SPOT_SUPABASE_SECRET_KEY`: the server-only secret key (legacy service-role key is also supported).
- `SPOT_ADMIN_EMAIL`: the confirmed provider identity that will manage invitations.
- `SPOT_PUBLIC_ORIGIN`: the SPOT service's HTTPS origin, used for private links; Render's external URL is the fallback.
- `SPOT_SESSION_SECRET`: an optional long random cookie-signing secret. If omitted, a fresh strong secret is generated on process startup. Restarting the service signs users out in either case because the token vault is in memory.

The configured owner signs in with their existing provider password. Successful verified sign-in establishes the independent SPOT owner record. The owner can create a private invitation link and share it directly; the application does not send invitation email. Existing confirmed identities activate SPOT with their existing password and a SPOT-only one-time nonce. New identities confirm their provider invitation and choose a password. SPOT approval lives only in `app_metadata.spot_explorer`; COP31 permissions are neither copied nor granted. Revoking SPOT access leaves other applications unchanged.

For password recovery, add the exact production URL `https://spot-explorer.onrender.com/account/reset` to Supabase's allowed redirect URLs. Preserve the shared Site URL and existing COP31 redirect entries. The standard recovery email template must retain `{{ .ConfirmationURL }}` so it honours the request-specific return address. The sign-in page's **Forgot password?** form requests a reset email for an eligible confirmed SPOT user or the configured owner. Open the email link in the same browser within 15 minutes. The server keeps the PKCE verifier and expected identity in memory, exchanges the one-time callback code, and presents a separate password form. A reset session cannot manage invitations or access an ordinary signed-in session before the password is saved. Restarting the service expires pending resets; request another email if needed.

A password reset changes the shared Supabase identity password, so it also changes the password used by any COP31 account with that identity. SPOT recovery preserves other applications' permission metadata. It does not approve COP31 access. Provider email delivery must be configured: the default Supabase mail service restricts recipients to project-team addresses and has a low sending limit. Wider client recovery needs a configured mail service. See [Supabase password recovery (year not stated; accessed 2026)](https://supabase.com/docs/guides/auth/passwords), [PKCE flow (year not stated; accessed 2026)](https://supabase.com/docs/guides/auth/sessions/pkce-flow), and [email delivery (year not stated; accessed 2026)](https://supabase.com/docs/guides/auth/auth-smtp).

Keep public signup and anonymous sign-in disabled on the shared provider. Never paste keys into source, chat, logs or downloaded handovers. `.env.example` contains placeholders only; the app reads environment variables rather than loading that file automatically. Run **one web worker** while sessions use the memory vault; a shared session store is needed before scaling to multiple workers/instances. Account responses are private and not cached; provider access/refresh tokens remain server-side. Unconfigured accounts fail closed while public results continue working. See [Supabase account configuration (year not stated; accessed 2026)](https://supabase.com/docs/guides/auth/general-configuration) and [server-owned user metadata (year not stated; accessed 2026)](https://supabase.com/docs/guides/auth/users).

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
| `/api/spatial/groups?scheme=UN%20Region&statistic=Mean` | Native regional summaries and explicit member-country IDs; schemes also include UN Subregion, UN Intermediate region, OECD region, Income category and World |
| `/api/municipal/meta` | Municipal source hashes, all country/area counts and map coverage |
| `/api/municipal/values?country=BRA&metric=plas_em&statistic=Mean` | One country's municipal values for one metric; optional `area` selects a native first-level area |
| `/api/municipal/map.png` | Bounded PNG viewport from private geometry; country/metric/statistic/area plus width/height/scale/tx/ty |
| `/api/municipal/selection.png` | Transparent highlight of one exact native municipality; country/municipality/optional area plus the same bounded viewport; no public vectors |
| `/api/municipal/inspect?country=BRA&metric=plas_em&lon=-46.6&lat=-23.5` | Source record at a point in the selected country/area; no nearest-name placement |

Profile and snapshot default to `IND`. Comparison and CSV default to entities `IND,CHN,USA`, metric `plas_em`, family `outputs`, statistic `Mean`. CSV includes release, model year, entity identity, family, metric, statistic, value and unit. JSON represents unavailable values as `null`; CSV uses an empty value field. Known zero values remain `0`.

Map selectors are `basis=total|per_capita` and `statistic=Mean|Median`; defaults are `total` and `Mean`. Total emissions use the released `plas_em` output in tonnes/year. Per-person emissions use the separate released `plas_em_per_cap` output in kg/person/year, including its own uncertainty summaries. The legacy `/api/map` route returns national entities only. The map workspace also reads the spatial group and municipal routes below; regional and world profiles remain available through the country search. The map changes the linked country profile when a user selects a shape or a country in its values table.

The atlas API accepts only `statistic=Mean|Median`, defaulting to Mean. Each row retains the released entity metadata and a `values` object keyed by output ID. Each metric contains `value`, `mean`, `median`, `low` and `high`; none is recalculated from another metric. This supplies the map concepts and country relationship charts without transferring the full research workbook to the browser.

## Map levels

The Level selector changes the statistical unit explicitly. Camera zoom does not silently switch a country value into a municipal value. National views can be filtered by native UN region, income category and country. Regional maps use the separately released summaries: one group colours its member countries and appears once in the table or symbols. Filtering cannot manufacture region-by-income intersections with valid native uncertainty.

Municipal views load one country at a time, with native first-level area selectors, name/ID search, point inspection, a paginated table and a scoped numeric CSV. Total/per-person and Mean/Median select separate native values. This version shades municipal areas; the four existing national/regional concepts remain available at those levels. All 50,702 native units across 246 entities are included in the prepared data (SPOT release 2026, modelled year 2020). The 126 units with no modelled population keep null results. Other undefined ratios also remain null. Small source numerical residuals are preserved, including negative values down to about -2.22e-14.

Selecting a municipality on the map, in Find municipality or in the data table adds an orange outline with a white halo and a light tint. The highlight is a separate transparent PNG, so selecting a place does not repaint the full country or fetch all its numerical values again. It follows pan/zoom and survives metric/statistic changes; changing country or area clears it. The source vectors stay private.

The browser never loads the 749 MB municipal workbook or global municipal vectors. Requests return only the selected metric. A private build-time index reads that metric without decoding the country's other 67 outputs; the verified compressed country partitions remain the fallback when the optional index is absent. The server retains one country's metadata, one metric and one country's simplified geometry. Image dimensions and compressed-response caching are bounded. Country/area colour limits change with the selected scope and appear in the legend. Performance measurements belong to the release receipt, not a blanket speed guarantee.

Municipal polygons retain the native model IDs and mixed administrative levels. “Municipal” therefore does not imply the same legal administrative unit in every country. Geometry simplification is for display and hit testing only; it does not change any modelled numbers. National and regional boundaries remain Natural Earth display outlines.

The raster painter uses a separate overview tolerance of approximately 0.35 pixels at the viewport centre, quantized from 0.001° to 0.064°. Zooming in restores the finest prepared display shapes. Point identification always uses those finest prepared shapes, independently of the overview paint rings. Each reporting unit remains present; invalid simplified shapes fall back to the finest valid shape. The active policy is recorded under `/api/municipal/meta.geometry.simplification.adaptive_paint`.

The matching municipal GIS member comes from the [SPOT release (2026)](https://doi.org/10.5281/zenodo.22231994). Its GADM-derived boundaries carry [GADM restrictions (year not stated; checked 16 October 2026)](https://gadm.org/license.html): academic/noncommercial use is allowed, while redistribution requires permission. The service renders PNG images and does not publish municipal vectors in GitHub, static assets or downloads. Applying the noncommercial-use permission to this research website is an interpretation, not explicit written permission for this particular website; obtain clarification before commercial reuse or adding vector exports. The original notices remain applicable.

`python scripts/prepare_municipal_geometry.py --download` prepares both private runtime assets without changing the existing deployment command. It first builds the per-metric values index at `.runtime/municipal_values/results.sqlite` from the verified numeric country partitions, then builds the ignored `.runtime/municipal` geometry asset from the matching release member, with length, CRC, source-hash and exact native-ID checks. The values index binds to the source manifest's hash and checks each requested blob; a stale or corrupt index fails closed. `python scripts/prepare_municipal_values.py` prepares only the values index. A local geometry copy can be used with `--source-gpkg PATH`. The original source is never modified. Display simplification and any validity repairs are recorded in the private manifest; its source hash and display qualifications are also reported by `/api/municipal/meta`. No vector export route exists. Numerical tables still work if the optional map asset is unavailable.

`python tools/prepare_municipal.py --source-root PATH` rebuilds the compressed numeric country partitions from the released municipal Outputs worksheet and input registry. It needs `lxml` in the preparation environment, which the running website does not use. Source-file hashes, metric-specific worksheet locators, units, all country/area counts and each compressed partition's hash are retained in `data/municipal/manifest.json`.

## Analysis views

- **Country shading:** a single metric, including native per-person rates and percentages.
- **Proportional circles:** one circle per SPOT reporting entity; circle area follows its value. Multipart countries do not produce repeated statistical observations.
- **Emission composition:** country pies split mean plastic emissions into debris and openly burned plastic. Pie area follows the selected total or native per-person amount. This view uses means because marginal medians and percentiles do not generally add to the median or percentile of a total.
- **Collection and emissions:** a nine-colour map combines country thirds of collection service coverage and plastic emissions per person. Numeric class bounds appear in the key. These are display groups, not performance targets or significance tests.
- **Relationships:** selectable country scatterplots, income/region filters, exact source units, log axes, area-scaled bubbles, source-value tooltips and a numerical table/CSV. Presets compare collection with emissions, plastic generation with emissions, debris with burning, and total emissions with emissions per person.
- **Sources:** six-country comparisons of litter, uncollected waste, collection, disposal and recycling. Total views use each native origin mean. Additive source shares divide source means by the native total mean. Origin emissions per person are derived as source mean tonnes/year times 1,000 divided by the supplied population; the native total per-person mean is retained separately. These calculations are labelled in the table and CSV. Stacked and separate bars use means; marginal medians and percentile bounds are not stacked. The complete 246-country list is available for selection.
- **Rankings:** total versus native per-person plastic emission ranks, or native emissions as a percentage of plastic waste generated (`plas_em_pct_pwg`). The percentage already includes multiplication by 100 and summarizes draw-level ratios; it is not recomputed from displayed mean masses. Mean/median, peer filters, a top-N slider and country highlighting are available. Exact ties use competition ranks (1, 1, 3); cutoff ties are retained. CSV/table include all 246 entities, native values and bounds, global ranks, within-filter ranks and explicit filter flags. Ranks order central estimates, not statistical certainty.

These views describe cross-sectional model results for 2020. They do not provide a trend or independent evidence of causation. Associations can reflect shared model inputs and model structure. Waste-generation rates retain their native kg/person/day units; emission rates retain kg/person/year. No time sequence or annualisation is invented for display. Region and income labels remain the classifications supplied with this release; the classification year of its output income labels is not stated.

Further views supported by the release include rigid/flexible plastic-format comparisons, people without collection (`people_no_col`), and a derived relative 5th–95th interval width. An interval-width view would show modelled dispersion, not accuracy or a confidence score. Rigid/flexible labels describe plastic formats, not polymer categories. A separately developed Sankey can be integrated as another tab.

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
