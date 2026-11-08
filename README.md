# Ponte Elízium

Liga o app **Elízium** do iPhone ao agente de programação **OpenCode** do seu computador (Mac, Linux ou Windows), de qualquer rede, sem VPN e com cifragem de ponta a ponta.

## Instalar

Mac e Linux (Terminal):

```bash
curl -fsSL https://raw.githubusercontent.com/jvbenicio2000/elizium-ponte/main/instaladores/instalar.sh | bash
```

Windows (PowerShell):

```powershell
irm https://raw.githubusercontent.com/jvbenicio2000/elizium-ponte/main/instaladores/instalar.ps1 | iex
```

O instalador não pede senha de administrador. Ele instala, na pasta do usuário, o Node (se faltar), o OpenCode e a ponte; pergunta se a ponte deve ligar sozinha quando o computador inicia; e mostra o QR code e o código de pareamento. Para ver o código de novo: `node ~/elizium-ponte/ponte.mjs --codigo`.

## Como funciona

```
iPhone ──WebSocket cifrado──> Transmissor Elízium ──> ponte (este computador) ──> opencode serve (127.0.0.1)
```

- **Transmissor** (`transmissor/`): um Cloudflare Worker com um Durable Object por computador. Ele só repassa bytes cifrados; não consegue ler nada.
- **Cifragem** (`ponte/transmissor.mjs` e o app): iPhone e computador têm pares de chaves X25519 fixos. A cada conexão fazem um aperto de mão em duas etapas, no estilo do Noise IK (chaves temporárias + fixas, HKDF-SHA256), e cifram tudo com ChaCha20-Poly1305. A chave fixa do iPhone só viaja cifrada: o transmissor não sabe nem qual iPhone está conectando.
- **O que o transmissor vê**: o id aleatório do computador, horários, tamanhos das mensagens e os endereços IP. Não vê perguntas, respostas, arquivos nem chaves.
- **Pareamento**: o computador mostra um código de uso único (vale 30 minutos). Na primeira conexão o iPhone manda esse código já cifrado e passa a ser reconhecido para sempre. O endereço é fixo: não precisa parear de novo quando a ponte religa.
- **OpenCode** só escuta em 127.0.0.1, com uma senha interna que nunca sai do computador. As chaves de provedores de IA saem do iPhone e ficam no OpenCode do computador escolhido.
- **Arquivos do iPhone** (desde a 0.4.0): o app manda arquivos em pedaços de 300 KB, que a ponte junta e grava só dentro da pasta do usuário, sem nunca substituir um arquivo existente. Relatórios de conversa vão para a pasta escolhida no app (padrão `Documents/Elízium`); anexos de conversa vão para `Documents/Elízium/Anexos`. Word, Excel e PowerPoint (.docx, .xlsx, .pptx) ganham ao lado uma cópia em texto (`.txt`), para qualquer modelo conseguir ler.
- Modo antigo, sem transmissor: `node ponte.mjs --tunel` usa um túnel rápido da Cloudflare (precisa do cloudflared).

## Publicar o transmissor

```bash
cd transmissor && npm install && npx wrangler login && npx wrangler deploy
```

## Créditos

- [OpenCode](https://github.com/anomalyco/opencode), licença MIT. A ponte só usa a API pública dele e não altera o OpenCode.
- [Cloudflare Workers](https://workers.cloudflare.com) e [cloudflared](https://github.com/cloudflare/cloudflared).
- [qrcode-terminal](https://github.com/gtanner/qrcode-terminal).

Licença: MIT.
