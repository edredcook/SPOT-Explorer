# SPOT Explorer

A public, read-only explorer for the released SPOT MFA V1.4.1-G-0426 baseline results for model year 2020. Country profiles, comparisons and downloads use the saved release; this stage does not run the model or accept uploaded data.

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
| `/api/compare?entities=IND,GBR&metric=plas_em&family=outputs&statistic=Mean` | Selected values and their released 5th/median/95th summaries |
| `/api/download` | CSV for the same selectors as comparison |
| `/api/snapshot?entity=IND` | Downloadable JSON country snapshot |
| `/api/provenance` | Source and derived-file provenance manifest |

Profile and snapshot default to `IND`. Comparison and CSV default to entities `IND,CHN,USA`, metric `plas_em`, family `outputs`, statistic `Mean`. CSV includes release, model year, entity identity, family, metric, statistic, value and unit. JSON represents unavailable values as `null`; CSV uses an empty value field. Known zero values remain `0`.

The 5th and 95th values describe the released Monte Carlo summaries. The mean can fall outside that interval in a skewed distribution; it is not an error bound around the selected statistic. Summaries must not be added to invent new regional uncertainty intervals. Use the released regional/global results where available.

## Data and attribution

The original released estimates are from Cottom, Cook and Velis (2026), *SPOT model - MFA Version 1.4.1-G-0426* ([dataset DOI](https://doi.org/10.5281/zenodo.22231994)). The methodology is described by Cottom, Cook and Velis (2024), *A local-to-global emissions inventory of macroplastic pollution* ([Nature paper](https://doi.org/10.1038/s41586-024-07758-6)). Retain the source citation, model year, units and version when reusing downloads. See `LICENSE` for the supplied CC BY 4.0 attribution notice and third-party-source qualifications.

The explorer reads its packaged data relative to `app.py`, rather than relying on the launch directory. Its provenance manifest records the release source and hashes. It must not contain workstation paths, credentials or private review material. Preserve the current release files when adding a new release; update the manifest and run the checks before switching the website to new data.

`tools/prepare_data.py --source-root PATH --output data` rebuilds the derived bundle from a complete local release folder. It requires `openpyxl` in the **preparation environment**; the website runtime does not need it. Treat this as an explicit release-maintenance action because it replaces the packaged bundle. The source workbook comparison in `tests/test_data.py` runs when `openpyxl` and the sibling `MFA_V1.4.1-G-0426` source folder are available; it is skipped in a standalone deployment. The remaining checks verify the packaged release identity, hashes, numeric identities, quantiles and API/export behavior without the original research archive.

## Maintenance boundary

The site serves saved baseline data. It has no project accounts, upload service, model execution worker or shared-data submissions. Those capabilities require a separately versioned service. Review numerical model changes separately from this explorer so that the displayed release remains traceable.

Implementation references checked 15 October 2026: [Flask 3.1.3](https://pypi.org/project/Flask/3.1.3/), [Gunicorn 26.2.0](https://pypi.org/project/gunicorn/26.2.0/), [Render Blueprint specification](https://render.com/docs/blueprint-spec), [GitHub checkout](https://github.com/actions/checkout), [GitHub setup-python](https://github.com/actions/setup-python).
