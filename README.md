# Ponte Elízium

Liga o app **Elízium** do iPhone aos agentes de programação **OpenCode** e **Claude Code** do seu computador (Mac, Linux ou Windows), de qualquer rede, sem VPN e com cifragem de ponta a ponta.

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
- **Arquivos do iPhone** (desde a 0.4.0): o app manda arquivos em pedaços de 300 KB, que a ponte junta e grava só dentro da pasta do usuário, sem nunca substituir um arquivo existente. Relatórios de conversa vão para a pasta escolhida no app (padrão `Documents/Elízium`); anexos de conversa vão para `Documents/Elízium/Anexos`. Word, Excel e PowerPoint (.docx, .xlsx, .pptx) ganham ao lado uma cópia em texto (`.txt`), para qualquer modelo conseguir ler. No Mac, quando a ponte liga sozinha, o sistema pergunta uma vez, na tela do computador, se o `node` pode usar a pasta Documentos; da 0.9.1 em diante a pergunta aparece já na partida e, enquanto ninguém responde, um arquivo que chegue do celular é recusado com a explicação, em vez de travar a ponte.
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

## Política da empresa (0.5.0)

O administrador da empresa pode limitar o que o OpenCode faz quando é usado pela ponte. As regras dele valem para toda sessão aberta pelo iPhone, ficam por último e por isso vencem as do app (no OpenCode, a última regra que casa é a que vale). O campo `tools` das mensagens, que trocaria as regras da sessão, é descartado quando há política.

```json
{
  "empresa": "Nome da empresa",
  "administrador": "ti@empresa.com",
  "regras": [
    { "permission": "bash", "pattern": "*", "action": "deny" },
    { "permission": "read", "pattern": "*financeiro*", "action": "deny" }
  ]
}
```

- Instalar na pasta do usuário: `node ponte.mjs --politica politica.json`; tirar: `node ponte.mjs --sem-politica`.
- Para o usuário não poder tirar, o administrador grava o arquivo na pasta do sistema, que tem prioridade: `C:\ProgramData\Elizium\politica.json` (Windows), `/Library/Application Support/Elizium/politica.json` (Mac) ou `/etc/elizium/politica.json` (Linux).
- A ponte relê o arquivo a cada mensagem; um arquivo ilegível bloqueia tudo.
- O app mostra a empresa e o número de regras na tela do computador.

## Claude Code (0.6.0)

Se o Claude Code estiver instalado no computador, o app pode usar ele no lugar do OpenCode: na tela do computador, em Agente, escolha Claude Code. A ponte roda `claude -p` na pasta do projeto, com o histórico do próprio Claude Code (as sessões abertas no terminal também aparecem no iPhone), e os pedidos de permissão chegam ao iPhone como os do OpenCode. Modos: Pedir, Aceitar edições, Liberar tudo e Só planejar.

- Conta do Claude Code: usa o login que já está no computador (Opus, Sonnet, Haiku ou o padrão).
- Outros provedores: a ponte traz um tradutor (`gateway.mjs`, só em 127.0.0.1) que recebe os pedidos do Claude Code e repassa a quem já fala a API da Anthropic (Anthropic, MiniMax…) ou traduz para a API de chat da OpenAI (OpenAI, Google, xAI, Groq, DeepSeek, Kimi, OpenRouter…). As chaves são as que o iPhone já envia ao computador. Os modelos grátis do OpenCode não servem aqui: eles só atendem o próprio OpenCode.
- Claude Code do computador: o app pode apontar o Claude Code usado no terminal para um desses modelos (grava `env` em `~/.claude/settings.json` e guarda os valores anteriores) e voltar ao padrão. Enquanto estiver apontado, a ponte precisa estar ligada.
- Política da empresa: as regras `deny` viram regras de bloqueio do Claude Code, cada pedido de permissão é conferido contra a política e o modo Liberar tudo deixa de existir. Para proibir o Claude Code no computador, ponha `"claudeCode": false` na política.
- Outros modelos funcionam pior que os Claude nas ferramentas do Claude Code; recursos como pensamento estendido e cache não passam pelo tradutor.

## Modelos do computador (0.7.0; baixar, remover e imagem na 0.8.0; pesquisa na 0.9.0, na 0.9.1 e na 0.9.2)

O app pode conversar, na aba Conversas, com um modelo que roda neste computador, sem chave: a ponte procura o Ollama (porta 11434), o LM Studio (1234), o llama.cpp (8080) e o Jan (1337), mostra ao app os modelos de cada um e faz a chamada em 127.0.0.1. Modelos que enxergam imagem recebem a imagem junto da pergunta. A resposta chega ao celular por consulta longa, porque a resposta ao vivo desses servidores não atravessa o transmissor nem o túnel.

- O app escolhe um servidor da lista da ponte; nunca manda endereço. Outros servidores entram pelo `config.json` do computador.
- A ponte não guarda as conversas.
- Baixar e remover modelos pelo celular (0.8.0): no Ollama, pelo nome do modelo na biblioteca; no ComfyUI, pelo endereço https de um arquivo `.safetensors`, que vai para a pasta de checkpoints. A ponte informa o tamanho e o espaço livre antes, e o download segue no computador mesmo com o app fechado. Da 0.8.1 em diante, cancelar um download do Ollama apaga também os pedaços que ele deixava no disco. Da 0.8.2 em diante, o download pelo endereço usa o módulo `https` do Node, porque o `fetch` trazia o arquivo cerca de sete vezes mais devagar num Mac.
- Pesquisar modelos pelo celular (0.9.0): o app mostra sugestões enquanto a pessoa escreve o nome, e depois as variantes com o tamanho. No Ollama, a ponte lê a página pública de pesquisa do site do Ollama (ele não tem uma API de pesquisa; se o site mudar, vale o nome escrito à mão). Da 0.9.1 em diante a pesquisa traz também os modelos que as pessoas publicam no site do Ollama com a conta delas (`pessoa/modelo`), marcados como da comunidade; o Ollama não confere esses modelos, e a ponte também não. Da 0.9.2 em diante vêm junto os modelos GGUF do Hugging Face, que o Ollama baixa pelo nome `hf.co/pessoa/repositório:variante`, com as variantes e o tamanho de cada uma; as sugestões deixam de fora os que pedem login, os marcados como conteúdo adulto, os partidos em vários arquivos e os nomes que o Ollama não aceita, e a ponte também não confere esses modelos. No ComfyUI, usa a API do Hugging Face e só sugere modelos abertos da família Stable Diffusion, sem os marcados como conteúdo adulto; os outros continuam entrando pelo endereço.
- Gerar imagem (0.8.0): se o ComfyUI estiver ligado (porta 8188), os checkpoints dele aparecem como modelos de imagem e o app gera a imagem neste computador. A imagem pronta vai para o celular e não fica guardada aqui.
- O contrato completo, para quem escreve o app, está em [LOCAIS.md](LOCAIS.md).

