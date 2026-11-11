#!/usr/bin/env bash
# Instalador da Ponte Elízium para Mac e Linux.
#   curl -fsSL https://raw.githubusercontent.com/jvbenicio2000/elizium-ponte/main/instaladores/instalar.sh | bash
# Instala tudo na pasta do usuário, sem pedir senha: Node (se faltar), OpenCode e a ponte.
set -euo pipefail

REPO="${ELIZIUM_REPO:-jvbenicio2000/elizium-ponte}"
RAMO="${ELIZIUM_RAMO:-main}"
TRANSMISSOR="${ELIZIUM_TRANSMISSOR:-https://elizium-transmissor.elizium-transmissor.workers.dev}"
DESTINO="$HOME/elizium-ponte"
BASE="${ELIZIUM_BASE:-https://raw.githubusercontent.com/$REPO/$RAMO}"

diga() { printf '\n%s\n' "$*"; }
falha() { printf '\nErro: %s\n' "$*" >&2; exit 1; }
pergunta() {  # lê do teclado mesmo quando o script veio por "curl | bash"
  local resposta=""
  # A pergunta vai escrita direto no terminal: o "read -p" a escreve na saída de erro, que aqui é descartada.
  if { : < /dev/tty; } 2>/dev/null; then
    printf '%s ' "$1" > /dev/tty
    read -r resposta < /dev/tty 2>/dev/null || true
  fi
  printf '%s' "$resposta"
}

case "$(uname -s)" in Darwin) SO=darwin ;; Linux) SO=linux ;; *) falha "sistema não suportado: $(uname -s)" ;; esac
case "$(uname -m)" in x86_64|amd64) ARQ=x64 ;; arm64|aarch64) ARQ=arm64 ;; *) falha "processador não suportado: $(uname -m)" ;; esac
mkdir -p "$HOME/.local/bin" "$DESTINO"
export PATH="$HOME/.local/node/bin:$HOME/.local/bin:$PATH"

# 1. Node 22 ou mais novo (a ponte usa o WebSocket embutido do Node).
precisa_node=1
if command -v node >/dev/null 2>&1; then
  maior=$(node -p 'process.versions.node.split(".")[0]')
  [ "$maior" -ge 22 ] && precisa_node=0
fi
if [ "$precisa_node" = 1 ]; then
  diga "Instalando o Node na pasta do usuário…"
  dist="https://nodejs.org/dist/latest-v24.x"
  arquivo=$(curl -fsSL "$dist/SHASUMS256.txt" | grep -o "node-v[0-9.]*-$SO-$ARQ.tar.xz" | head -1)
  [ -n "$arquivo" ] || falha "não achei o Node para $SO-$ARQ"
  tmp=$(mktemp -d)
  curl -fsSL -o "$tmp/$arquivo" "$dist/$arquivo"
  esperado=$(curl -fsSL "$dist/SHASUMS256.txt" | grep " $arquivo\$" | cut -d' ' -f1)
  obtido=$( (command -v sha256sum >/dev/null && sha256sum "$tmp/$arquivo" || shasum -a 256 "$tmp/$arquivo") | cut -d' ' -f1)
  [ "$esperado" = "$obtido" ] || falha "a impressão digital do Node não confere"
  mkdir -p "$HOME/.local/node"
  tar -xJf "$tmp/$arquivo" -C "$HOME/.local/node" --strip-components=1
  rm -rf "$tmp"
  for perfil in "$HOME/.profile" "$HOME/.bashrc" "$HOME/.zshrc"; do
    [ -f "$perfil" ] || [ "$perfil" = "$HOME/.profile" ] || continue
    grep -q '.local/node/bin' "$perfil" 2>/dev/null || echo 'export PATH="$HOME/.local/node/bin:$HOME/.local/bin:$PATH"' >> "$perfil"
  done
fi
echo "Node $(node -v)"

# 2. OpenCode (aberto, licença MIT, anomalyco/opencode).
if ! command -v opencode >/dev/null 2>&1; then
  diga "Instalando o OpenCode…"
  npm install -g --allow-scripts=opencode-ai opencode-ai >/dev/null 2>&1 || npm install -g opencode-ai >/dev/null
fi
echo "OpenCode $(opencode --version)"

# 3. A ponte.
diga "Baixando a ponte…"
for f in ponte.mjs transmissor.mjs claudecode.mjs gateway.mjs locais.mjs package.json; do curl -fsSL -o "$DESTINO/$f" "$BASE/ponte/$f"; done
(cd "$DESTINO" && npm install --no-fund --no-audit --omit=dev >/dev/null)
mkdir -p "$HOME/.elizium-ponte"
case "$TRANSMISSOR" in __*) ;; *) printf '{ "transmissor": "%s" }\n' "$TRANSMISSOR" > "$HOME/.elizium-ponte/config.json" ;; esac

# 4. Ligar sozinha ao iniciar o computador?
resposta=$(pergunta "Ligar a ponte sozinha sempre que este computador iniciar? (s/n)")
NODE_BIN="$(command -v node)"
if [[ "$resposta" =~ ^[sSyY] ]]; then
  if [ "$SO" = darwin ]; then
    plist="$HOME/Library/LaunchAgents/com.elizium.ponte.plist"
    mkdir -p "$(dirname "$plist")"
    cat > "$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.elizium.ponte</string>
  <key>ProgramArguments</key><array><string>$NODE_BIN</string><string>$DESTINO/ponte.mjs</string></array>
  <key>WorkingDirectory</key><string>$DESTINO</string>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>$HOME/.local/node/bin:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin</string></dict>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$HOME/.elizium-ponte/ponte.log</string>
  <key>StandardErrorPath</key><string>$HOME/.elizium-ponte/ponte.log</string>
</dict></plist>
PLIST
    launchctl bootout "gui/$(id -u)/com.elizium.ponte" 2>/dev/null || true
    launchctl bootstrap "gui/$(id -u)" "$plist"
  else
    unit="$HOME/.config/systemd/user/elizium-ponte.service"
    mkdir -p "$(dirname "$unit")"
    cat > "$unit" <<UNIT
[Unit]
Description=Ponte Elízium
After=network-online.target

[Service]
WorkingDirectory=$DESTINO
Environment=PATH=$HOME/.local/node/bin:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=$NODE_BIN $DESTINO/ponte.mjs
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
UNIT
    systemctl --user daemon-reload
    systemctl --user enable --now elizium-ponte.service
    loginctl enable-linger "$USER" 2>/dev/null || echo "(Para ligar antes do login, rode uma vez: sudo loginctl enable-linger $USER)"
  fi
  diga "A ponte está ligada e vai ligar sozinha nas próximas vezes."
  sleep 8
  "$NODE_BIN" "$DESTINO/ponte.mjs" --codigo
  diga "Para ver o código de pareamento de novo: node $DESTINO/ponte.mjs --codigo"
else
  diga "Ligando a ponte agora (Control-C desliga)…"
  exec "$NODE_BIN" "$DESTINO/ponte.mjs"
fi
