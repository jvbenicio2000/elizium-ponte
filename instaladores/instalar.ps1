# Instalador da Ponte Elízium para Windows (PowerShell).
#   irm https://raw.githubusercontent.com/jvbenicio2000/elizium-ponte/main/instaladores/instalar.ps1 | iex
# Instala tudo na pasta do usuário, sem pedir administrador: Node (se faltar), OpenCode e a ponte.
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$Repo = if ($env:ELIZIUM_REPO) { $env:ELIZIUM_REPO } else { "jvbenicio2000/elizium-ponte" }
$Ramo = if ($env:ELIZIUM_RAMO) { $env:ELIZIUM_RAMO } else { "main" }
$Transmissor = if ($env:ELIZIUM_TRANSMISSOR) { $env:ELIZIUM_TRANSMISSOR } else { "https://elizium-transmissor.elizium-transmissor.workers.dev" }
$Destino = Join-Path $env:USERPROFILE "elizium-ponte"
$Base = if ($env:ELIZIUM_BASE) { $env:ELIZIUM_BASE } else { "https://raw.githubusercontent.com/$Repo/$Ramo" }
$NodeDir = Join-Path $env:LOCALAPPDATA "elizium-node"
New-Item -ItemType Directory -Force -Path $Destino | Out-Null

function Diga($t) { Write-Host ""; Write-Host $t }

# 1. Node 22 ou mais novo.
$node = Get-Command node -ErrorAction SilentlyContinue
$precisa = $true
if ($node) { $maior = [int](& node -p "process.versions.node.split('.')[0]"); if ($maior -ge 22) { $precisa = $false } }
if ($precisa) {
  Diga "Instalando o Node na pasta do usuário…"
  $arq = if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "arm64" } else { "x64" }
  $dist = "https://nodejs.org/dist/latest-v24.x"
  $somas = (Invoke-WebRequest "$dist/SHASUMS256.txt" -UseBasicParsing).Content
  $arquivo = ([regex]"node-v[0-9.]+-win-$arq\.zip").Match($somas).Value
  if (-not $arquivo) { throw "Não achei o Node para win-$arq" }
  $zip = Join-Path $env:TEMP $arquivo
  Invoke-WebRequest "$dist/$arquivo" -OutFile $zip -UseBasicParsing
  $esperado = (($somas -split "`n") | Where-Object { $_ -match " $([regex]::Escape($arquivo))$" }).Split(" ")[0]
  $obtido = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
  if ($esperado -ne $obtido) { throw "A impressão digital do Node não confere" }
  if (Test-Path $NodeDir) { Remove-Item -Recurse -Force $NodeDir }
  Expand-Archive $zip -DestinationPath $env:TEMP -Force
  Move-Item (Join-Path $env:TEMP ($arquivo -replace "\.zip$", "")) $NodeDir
  Remove-Item $zip
  $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
  if ($userPath -notlike "*$NodeDir*") { [Environment]::SetEnvironmentVariable("Path", "$NodeDir;$env:APPDATA\npm;$userPath", "User") }
  $env:Path = "$NodeDir;$env:APPDATA\npm;$env:Path"
}
Write-Host "Node $(& node -v)"

# 2. OpenCode (aberto, licença MIT, anomalyco/opencode).
if (-not (Get-Command opencode -ErrorAction SilentlyContinue)) {
  Diga "Instalando o OpenCode…"
  & npm install -g --allow-scripts=opencode-ai opencode-ai | Out-Null
  $env:Path = "$env:APPDATA\npm;$env:Path"
}
Write-Host "OpenCode $(& opencode --version)"

# 3. A ponte.
Diga "Baixando a ponte…"
foreach ($f in "ponte.mjs", "transmissor.mjs", "package.json") {
  Invoke-WebRequest "$Base/ponte/$f" -OutFile (Join-Path $Destino $f) -UseBasicParsing
}
Push-Location $Destino; & npm install --no-fund --no-audit --omit=dev | Out-Null; Pop-Location
$cfgDir = Join-Path $env:USERPROFILE ".elizium-ponte"
New-Item -ItemType Directory -Force -Path $cfgDir | Out-Null
if (-not $Transmissor.StartsWith("__")) {
  Set-Content -Path (Join-Path $cfgDir "config.json") -Value "{ `"transmissor`": `"$Transmissor`" }" -Encoding UTF8
}

# 4. Ligar sozinha ao entrar no Windows?
$nodeExe = (Get-Command node).Source
$resposta = Read-Host "Ligar a ponte sozinha sempre que você entrar no Windows? (s/n)"
if ($resposta -match "^[sSyY]") {
  $inicio = [Environment]::GetFolderPath("Startup")
  $vbs = Join-Path $inicio "Ponte Elizium.vbs"
  $log = Join-Path $cfgDir "ponte.log"
  # A small VBS starts the bridge with no window. The whole cmd line goes inside one more pair of quotes:
  # with more than two quotes, cmd /c drops the first and the last, which broke the path to node.
  Set-Content -Path $vbs -Encoding ASCII -Value @"
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = "$Destino"
sh.Run "cmd /c """"$nodeExe"" ""$Destino\ponte.mjs"" > ""$log"" 2>&1""", 0, False
"@
  Start-Process wscript.exe -ArgumentList "`"$vbs`""
  Diga "A ponte está ligada e vai ligar sozinha nas próximas vezes."
  Start-Sleep -Seconds 10
  & $nodeExe (Join-Path $Destino "ponte.mjs") --codigo
  Diga "Para ver o código de pareamento de novo: node `"$Destino\ponte.mjs`" --codigo"
} else {
  Diga "Ligando a ponte agora (Control-C desliga)…"
  & $nodeExe (Join-Path $Destino "ponte.mjs")
}
