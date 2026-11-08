# MinerU compatibility checks

The local client detects MinerU V1 before choosing a parsing protocol.
MinerU 4 uses uploads, parse jobs, and ZIP output.
MinerU 3 uses its health endpoint and synchronous `/file_parse` route.
MinerU 2 can advertise `/file_parse` through OpenAPI when it has no health endpoint.
Authentication and server failures do not trigger a fallback to another protocol.

## Settings

Start the MinerU API service separately, then enter its base URL in Zotero.
Use **Test Connection** to identify the API and show its available settings.
A successful connection test does not perform PDF parsing.

For MinerU 4, select a quality tier or use Auto.
Auto uses the best tier the server offers: standard, then basic, then flash.
A selected tier that the server does not offer falls back to the closest offered tier, and the parse progress says so.
The plugin always sends an explicit tier, so a Flash-only server works with Auto.
Test Connection lists the offered tiers and the tier the next parse will use.
Each parse detects the service again, so a server restarted with other tiers needs no settings change.
Configure external VLM engines on the MinerU 4 service.
For MinerU 3, select a backend and optionally set hybrid effort, image analysis, and an HTTP-client VLM server URL.
Hybrid image analysis requires high effort.
The optional local API key authenticates the MinerU API service; it is separate from the cloud key.

V1 requests cover all PDF pages in each existing upload chunk.
The client converts the released `structured_content.json` pages/blocks format into the existing cache metadata.
It checks image availability and PDF page counts before cache publication.
Incomplete or failed results do not replace a complete cache.
V1 polling has a two-hour limit per upload chunk, and each request has a separate timeout.
Pause requests V1 job cancellation; legacy synchronous servers can continue processing after the client stops waiting.

## Automated checks

Run the static checks:

```sh
npm run typecheck
```

Run the native checks with a disposable Zotero profile:

```sh
mkdir -p .scaffold/mineru-workflow
for source in test-workflows/mineru*.workflow.test.ts; do
  ln -sf "../../$source" ".scaffold/mineru-workflow/$(basename "$source")"
done
ZOTERO_PLUGIN_ZOTERO_BIN_PATH=/Applications/Zotero.app/Contents/MacOS/zotero \
  LLM_FOR_ZOTERO_TEST_ENTRIES=.scaffold/mineru-workflow npm run test:workflow
```

The scaffold owns `.scaffold/test/profile` and `.scaffold/test/data` for these checks.
The native suite verifies cache publication, figure metadata, settings, long-PDF handling, and recovery.
It also writes settings screenshots into the disposable data directory.
Its network responses are controlled fixtures.

## Live service check

Use a separate Python environment and install a pinned MinerU version.
MinerU 3 requires a Python version below 3.14.
MinerU 4.0.6 was tested with Python 3.14 and docvortex 0.5.8.
The released docvortex 0.4.22 structured-content format has the same pages/blocks layout used by the adapter.

Start the real V1 service:

```sh
mineru-kit api-server --host 127.0.0.1 --port 18746 --tier flash
```

Run the opt-in native test:

```sh
ZOTERO_PLUGIN_ZOTERO_BIN_PATH=/Applications/Zotero.app/Contents/MacOS/zotero \
  LLM_FOR_ZOTERO_TEST_ENTRIES=test-live/mineru npm run test:workflow
```

This test runs once with Flash selected and once with Auto, against the Flash-only server.
Each run creates a two-page PDF with an image inside the disposable profile.
It checks the real service, uploads the PDF, polls the job, downloads its output, and publishes the cache.
It verifies both pages and the image metadata through native Zotero storage.
The test saves `mineru-live-evidence-flash.json` and `mineru-live-evidence-auto.json` in the disposable data directory.
Flash can load OCR resources for scanned or sparse PDFs, so prepare the service's required models before testing those inputs.

For a separate client check with your own local test PDF:

```sh
MINERU_TEST_URL=http://127.0.0.1:18746 \
  npx tsx scripts/test-mineru-local-live.ts /path/to/test.pdf auto
```

The tier argument is optional and defaults to `auto`.

The script saves a summary in `.scaffold/mineru-validation/live-result.json`.
Set `MINERU_TEST_API_KEY` only if your local service requires authentication.
The script does not read the cloud key.

## Validation boundaries

A live Flash test proves the local transport, result conversion, and cache workflow for its input.
It does not establish the accuracy of OCR or Standard/Advanced models.
Legacy request options have regression coverage against the released API fields.
A real MinerU 3.4.5 service was also checked for health and its API schema.
Legacy model inference and external VLM inference require separately provisioned models.

Issue #490 also reports a cloud waiting state.
The cloud regressions cover polling transitions, server failure details, invalid statuses, authentication failures, and connection-test errors.
Reproducing that user's cloud queue delay still requires their server response and timing evidence.

Sources: [MinerU migration guide](https://opendatalab.github.io/MinerU/reference/migration_4/), [V1 HTTP API](https://opendatalab.github.io/MinerU/usage/http_api/), and [cloud API](https://mineru.net/apiManage/docs).
