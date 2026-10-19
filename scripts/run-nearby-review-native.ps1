$ErrorActionPreference = 'Stop'
$nativeRoot = Join-Path $env:USERPROFILE '.emergency-response-local/development'
$spec = Get-Content -LiteralPath (Join-Path $nativeRoot 'backend-private.json') -Raw | ConvertFrom-Json
$nativeBin = Join-Path $nativeRoot 'runtime/pgsql/bin'
if ((Resolve-Path -LiteralPath $nativeBin).Path -ne (Join-Path $spec.runtime 'pgsql/bin')) { throw 'NATIVE_RUNTIME_PATH_CHANGED' }
foreach ($binary in @('postgres.exe', 'pg_ctl.exe')) {
  if ((Get-FileHash -LiteralPath (Join-Path $nativeBin $binary)).Hash.ToLowerInvariant() -ne $spec.executableHashes.$binary) { throw 'NATIVE_RUNTIME_PIN_CHANGED' }
}
# Preserve the existing native suite's explicitly approved local port.
if ([Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners().Port -contains 55433) { throw 'NATIVE_TEST_PORT_IN_USE' }
$fixtureRoot = Join-Path ([IO.Path]::GetTempPath()) ('er-nearby-native-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $fixtureRoot | Out-Null
$fixtureData = Join-Path $fixtureRoot 'data'
function Invoke-FixtureNative([string]$binary, [string[]]$arguments, [string]$label) {
  $process = Start-Process -FilePath (Join-Path $nativeBin $binary) -ArgumentList $arguments -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput (Join-Path $fixtureRoot ($label + '.stdout.log')) -RedirectStandardError (Join-Path $fixtureRoot ($label + '.stderr.log'))
  # Start-Process -Wait waits for daemon descendants too. Wait for this exact
  # short-lived control process, never the PostgreSQL server's entire tree.
  if (-not $process.WaitForExit(45000) -or $process.ExitCode -ne 0) { throw ('NATIVE_' + $label.ToUpperInvariant() + '_FAILED') }
}
$started = $false
try {
  Write-Output ('SYNTHETIC_FIXTURE ' + $fixtureRoot)
  Invoke-FixtureNative 'initdb.exe' @('-D', $fixtureData, '-U', 'postgres', '-A', 'trust', '--no-locale', '-E', 'UTF8') 'init'
  Invoke-FixtureNative 'pg_ctl.exe' @('start', '-D', $fixtureData, '-l', (Join-Path $fixtureRoot 'postgres.log'), '-w', '-t', '30', '-o', '"-h 127.0.0.1 -p 55433 -c unix_socket_directories= -c log_min_messages=panic -c log_min_error_statement=panic -c log_statement=none"') 'start'
  $started = $true
  Invoke-FixtureNative 'createdb.exe' @('-h', '127.0.0.1', '-p', '55433', '-U', 'postgres', 'alert_disposable') 'create'
  $env:DISPOSABLE_DATABASE_URL = 'postgresql://postgres@127.0.0.1:55433/alert_disposable?sslmode=disable'
  $env:DATABASE_URL = $env:DISPOSABLE_DATABASE_URL
  $env:DIRECT_URL = $env:DISPOSABLE_DATABASE_URL
  $env:CONFIRM_DISPOSABLE_DATABASE = 'alert_disposable'
  $env:NEARBY_REVIEW_ENABLED = 'false'
  $env:LOCAL_DEV_CONFIG_FILE = ''
  $env:DOTENV_CONFIG_QUIET = 'true'
  node scripts/run-native-alert-gate.mjs
  $gateExit = $LASTEXITCODE
} finally {
  if ($started) {
    Invoke-FixtureNative 'pg_ctl.exe' @('stop', '-D', $fixtureData, '-m', 'fast', '-w', '-t', '30') 'stop'
    Write-Output 'OWN_SYNTHETIC_CLUSTER_STOPPED'
  }
}
if ($gateExit -ne 0) { exit $gateExit }
