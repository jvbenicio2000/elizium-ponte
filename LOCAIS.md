# Modelos do computador: contrato da ponte (0.8.0)

Serve para o app usar um modelo que roda no computador pareado: conversar, na aba Conversas, com um modelo de texto (Ollama, LM Studio, llama.cpp, Jan ou outro servidor que fale a API de chat da OpenAI); gerar imagem com um modelo do ComfyUI; e, desde a 0.8.0, baixar e remover modelos do computador pelo celular. Não há chave: a ponte chama o servidor em 127.0.0.1 e o app fala só com a ponte, com a chave de pareamento de sempre.

Todos os endereços abaixo pedem `Authorization: Bearer <chave de pareamento>`, como o resto da ponte. A ponte que tem isso responde `"locais": true` em `GET /ponte/info`; se o campo faltar, a ponte é anterior à 0.7.0. Baixar, remover e gerar imagem existem a partir da 0.8.0: numa ponte mais antiga, os servidores da lista vêm sem os campos `baixa` e `remove`, e o app deve tratar a falta deles como "não pode".

## O que foi conferido

- Ollama: conferido de verdade em 10/11/2026, pelo app do iPhone (no simulador) falando com a ponte 0.7.0 de um Windows com o Ollama 0.40.13 e os modelos qwen3:1.7b e gemma3:4b. Passaram: a lista (com o campo `imagem`, o detalhe e o tamanho), a resposta de texto com o raciocínio separado, a resposta sobre uma foto com o gemma3:4b (a foto reduzida passa de 400 KB, então o pedido foi em pedaços), os números de uso e o app parar a resposta no meio. No registro do Ollama (`server.log`) esse pedido aparece cancelado no meio da geração (`srv stop: cancel task`), 6 segundos depois de começar. Com a ponte 0.7.1, no mesmo dia e pelo mesmo caminho, o app passou a mostrar o limite de 16 384 tokens para o gemma3:4b (antes mostrava 8192) e respondeu a uma pergunta nova.
- LM Studio, llama.cpp, Jan e servidores do `config.json`: escritos pela documentação de cada um. Não foram testados com o programa de verdade.
- Baixar e remover modelos, e gerar imagem pelo ComfyUI: conferidos em 10/11/2026 com os programas de verdade, pelo `teste-locais.mjs` rodando no próprio Windows (ponte 0.8.0, Ollama 0.40.13, ComfyUI 0.45.0 com o sd_xl_base_1.0, placa RTX 4080 de 12 GB). Esse teste chama o código da ponte direto, sem passar pelo transmissor nem pelo app. Passaram: a lista com `baixa`, `remove`, `tipo` e `proporcoes`; a consulta de tamanho e de espaço livre; baixar o gemma3:270m (292 MB em 25 segundos, com o andamento, `conferindo` e `pronto`) e removê-lo; o nome que não existe na biblioteca (400 com a frase); gerar uma imagem 16:9 de 1344x768 em 28 segundos, com o andamento passo a passo, sem o texto do pedido dentro do PNG e sem arquivo novo na pasta de saída do ComfyUI; cancelar a imagem no meio (a fila do ComfyUI ficou vazia); baixar, listar e remover um `.safetensors` de teste pelo endereço do Hugging Face com `/blob/`; e cancelar um download do Ollama no meio. Nesse último apareceu um defeito, corrigido na 0.8.1: o Ollama deixava na pasta dele os pedaços do download interrompido (769 MB naquele caso), sem aparecer em lista nenhuma.
- A correção da 0.8.1: conferida em 10/11/2026 com o Ollama de verdade, no mesmo Windows. Um download do gemma3:1b cancelado no meio não deixou nenhum arquivo `-partial` na pasta do Ollama, e os outros modelos ficaram como estavam.
- O caminho inteiro, pelo app e pelo transmissor: conferido em 10/11/2026 pelo app do iPhone (no simulador) falando com a ponte 0.8.1 desse Windows. Passaram, na tela do app: a lista com os dois servidores (Ollama e ComfyUI); a consulta de tamanho e de espaço livre pelo nome (gemma3:270m, no Ollama) e pelo endereço https (um `.safetensors` do Hugging Face, no ComfyUI); baixar o gemma3:270m até o fim, com o andamento; cancelar um download no meio; remover um modelo, com a confirmação; e gerar uma imagem 16:9 com o sd_xl_base_1.0, com o andamento passo a passo e a imagem chegando inteira ao celular.
- Ainda não conferidos: um download do ComfyUI pelo endereço começado no app (pelo app só foi feita a consulta do tamanho; o download em si passou no `teste-locais.mjs`), e a liberação da placa de vídeo 5 minutos depois da última imagem. Esta linha muda quando forem.

## Listar

`GET /ponte/locais`

```json
{ "servidores": [
  { "id": "ollama", "nome": "Ollama", "tipo": "ollama", "baixa": "nome", "remove": true,
    "modelos": [
      { "id": "gemma3:4b", "nome": "gemma3:4b", "tipo": "texto",
        "imagem": true, "raciocinio": false,
        "contexto": 16384, "contextoMaximo": 131072,
        "tamanho": 3338801804, "detalhe": "4.3B · Q4_K_M", "carregado": false } ] } ] }
```

- Só aparecem os servidores que responderam agora. Lista vazia quer dizer: nenhum servidor de modelos ligado neste computador.
- Um servidor ligado sem nenhum modelo aparece com `"modelos": []`.
- `id` do servidor: `ollama`, `lmstudio`, `llamacpp`, `jan`, `comfyui`, ou `config1`, `config2`… para os do `config.json`. O app guarda e devolve esse `id`; nunca manda endereço de servidor.
- `baixa` diz como se baixa um modelo novo nesse servidor: `"nome"` (o app pede o nome do modelo, como no Ollama: `gemma3:4b`), `"endereco"` (o app pede o endereço https do arquivo do modelo, como no ComfyUI) ou `null` (não dá para baixar por aqui). `remove` diz se dá para remover um modelo desse servidor.
- `tipo` do modelo: `"texto"` (serve para conversar) ou `"imagem"` (só gera imagem; não entra na lista de modelos de conversa). Um modelo de imagem traz também `proporcoes`, a lista de proporções que o app pode oferecer (`"1:1"`, `"4:3"`, `"3:4"`, `"16:9"`, `"9:16"`); nele `contexto` vem `null`.
- `imagem`: o modelo aceita imagem junto da pergunta.
- `raciocinio`: o modelo pode devolver raciocínio separado do texto.
- `contexto`: quantos tokens cabem na conversa, do jeito que a ponte vai chamar o modelo. É o número que o app usa como limite. `contextoMaximo` é o teto do próprio modelo e pode ser `null`.
- `tamanho` em bytes, ou `null`. `detalhe` é um texto curto para mostrar na lista e pode vir vazio.
- Modelos só de vetores (embedding) ficam de fora.

## Conversar

`POST /ponte/locais/conversa`

```json
{ "servidor": "ollama", "modelo": "gemma3:4b",
  "mensagens": [
    { "papel": "system", "texto": "Responda em português." },
    { "papel": "user", "texto": "O que tem nesta foto?", "imagens": ["<JPEG em base64>"] },
    { "papel": "assistant", "texto": "Um gato." },
    { "papel": "user", "texto": "De que cor?" } ],
  "temperatura": 0.7, "maxTokens": 1024 }
```

- A ponte não guarda a conversa: o app manda as instruções e o histórico inteiro a cada pergunta.
- `papel`: `system`, `user` ou `assistant`. `imagens` é opcional, base64 puro, sem `data:` na frente. Mande JPEG com o lado maior em torno de 1024.
- `temperatura` e `maxTokens` são opcionais; sem eles vale o padrão do servidor.
- Resposta: `{ "id": "…" }`. Pedido errado: 400 com `{ "erro": "…" }`.

Pedido grande: o corpo de um pedido do celular não pode passar de umas centenas de KB no transmissor. Acima de 300 KB, mande o mesmo JSON em pedaços, para o mesmo endereço:

```json
{ "envio": "<id que o app inventa>", "parte": 0, "total": 3, "dados": "<pedaço do JSON em base64>" }
```

`parte` começa em 0 e `total` vai até 400. Cada pedaço responde `{ "recebido": n, "total": t }`; o último responde `{ "id": "…" }`. Os pedaços são fatias dos bytes do JSON em UTF-8, cada uma em base64.

## Receber a resposta

`GET /ponte/locais/conversa/<id>?depois=N&espera=20`

```json
{ "pedacos": [ { "tipo": "raciocinio", "texto": "…" }, { "tipo": "texto", "texto": "…" } ],
  "proximo": 7, "fim": false, "erro": null, "uso": null }
```

- Comece com `depois=0` e, a cada volta, mande o `proximo` recebido. Repetir o mesmo `depois` devolve os mesmos pedaços de novo, então uma consulta perdida pode ser refeita sem perder texto.
- `espera` em segundos, até 50. Sem novidade nesse tempo, volta `pedacos` vazio; é só consultar de novo. A primeira resposta pode demorar: o servidor carrega o modelo na memória antes de começar.
- `tipo`: `texto` ou `raciocinio`. Junte os textos na ordem.
- Com `fim: true` acabou. `erro` traz a frase para mostrar à pessoa, ou `null`. `uso` traz `{ "entrada": n, "saida": n }` em tokens quando o servidor informa, ou `null`.
- 404 quer dizer que a resposta não existe mais (a ponte foi reiniciada, ou passou do prazo).
- A ponte cancela uma resposta que ninguém consulta há 5 minutos e apaga a resposta pronta depois de 10 minutos.

## Cancelar

`DELETE /ponte/locais/conversa/<id>` → `{ "ok": true }`. Para a geração no servidor.

## Baixar um modelo (0.8.0)

Antes de baixar, o app pergunta o tamanho, para confirmar com a pessoa:

`POST /ponte/locais/consultar`

```json
{ "servidor": "ollama", "modelo": "gemma3:4b" }
```

ou, num servidor com `"baixa": "endereco"`:

```json
{ "servidor": "comfyui", "endereco": "https://huggingface.co/…/resolve/main/modelo.safetensors", "nome": "modelo.safetensors" }
```

Resposta: `{ "servidor": "ollama", "modelo": "gemma3:4b", "tamanho": 3338801804, "livre": 858270142464, "instalado": false }`.

- `tamanho` e `livre` (espaço livre no disco dos modelos) em bytes; qualquer um dos dois pode vir `null` quando a ponte não consegue saber. `instalado` diz se esse modelo já está no computador (no Ollama, baixar de novo atualiza).
- `modelo` volta do jeito que vai aparecer na lista. No ComfyUI é o nome do arquivo.
- No Ollama o nome é o da biblioteca (`gemma3:4b`, `qwen3`, `hf.co/usuario/repositorio`). Nome que não existe na biblioteca: 400 com a frase.
- No ComfyUI o endereço precisa ser https, de um site (não vale endereço da rede local), e o arquivo precisa ser `.safetensors`. Endereço de página do Hugging Face (`/blob/`) é aceito e trocado pelo do arquivo. `nome` é opcional: sem ele vale o nome que o site informa. O arquivo vai para a pasta de checkpoints do ComfyUI; arquivo que pede login no site é recusado com a frase.
- Erro: 400 com `{ "erro": "…" }`, frase pronta para mostrar.

`POST /ponte/locais/baixar`, com o mesmo corpo → `{ "id": "…" }`. Pedir de novo o mesmo modelo enquanto ele baixa devolve o mesmo `id`. Cabem 3 downloads ao mesmo tempo por computador; o quarto volta 400 com a frase. Falta de espaço em disco também.

`GET /ponte/locais/baixar/<id>?depois=N&espera=20`

```json
{ "id": "…", "servidor": "ollama", "modelo": "gemma3:4b", "estado": "baixando",
  "total": 3338801804, "baixado": 1200000000, "proximo": 14, "fim": false, "erro": null }
```

- Consulta longa, como a da conversa: comece com `depois=0` (responde na hora) e mande de volta o `proximo` recebido; sem novidade em `espera` segundos (até 50), volta o mesmo estado.
- `estado`: `baixando`, `conferindo` (o servidor confere e grava o que baixou), `pronto`, `erro` ou `cancelado`. Com `fim: true` acabou; em `erro` e `cancelado`, `erro` traz a frase.
- `total` e `baixado` em bytes; `total` vale 0 enquanto não se sabe.
- O download continua no computador mesmo que o app feche: ele não é cancelado por falta de consulta. `GET /ponte/locais/baixar` → `{ "baixando": [ … ] }` devolve todos os downloads que a ponte conhece (em andamento e terminados há menos de 30 minutos), no mesmo formato, para o app mostrar ao abrir a tela.
- `DELETE /ponte/locais/baixar/<id>` → `{ "ok": true }`: cancela o download em andamento, ou tira da lista um que já terminou. Nos dois casos o `id` deixa de existir. 404 quer dizer que o download não existe mais (foi cancelado, a ponte foi reiniciada, ou passou do prazo); o app tira da tela.
- Cancelar um download do Ollama apaga do disco o que já tinha sido baixado dele (desde a 0.8.1; o Ollama, sozinho, guarda esses pedaços para continuar depois, e eles ocupam o tamanho inteiro do modelo). Um download que cai por outro motivo guarda os pedaços: pedir de novo continua de onde parou.
- No ComfyUI, um arquivo com o mesmo nome de um modelo que já está na pasta é recusado (o `instalado` da consulta avisa antes).
- Depois de `pronto`, o modelo aparece em `GET /ponte/locais`.

## Remover um modelo (0.8.0)

`POST /ponte/locais/remover`

```json
{ "servidor": "ollama", "modelo": "gemma3:4b" }
```

→ `{ "ok": true }`, ou 400 com `{ "erro": "…" }`. `modelo` é o `id` que veio na lista. No Ollama a ponte chama a remoção do próprio Ollama; no ComfyUI apaga o arquivo da pasta de checkpoints (só arquivo que o ComfyUI lista e que está dentro dessa pasta). O app deve pedir confirmação antes: não tem volta, só baixando de novo.

## Gerar imagem (0.8.0)

Só em servidor do tipo `comfyui`, com modelo de `tipo: "imagem"`.

`POST /ponte/locais/imagem`

```json
{ "servidor": "comfyui", "modelo": "sd_xl_base_1.0.safetensors",
  "texto": "um veleiro vermelho num mar azul calmo", "negativo": "", "proporcao": "16:9" }
```

- `texto` é obrigatório. `negativo` (o que não deve aparecer) e `proporcao` são opcionais; sem `proporcao` vale `1:1`.
- A ponte escolhe o tamanho, os passos e o amostrador que combinam com o modelo (1024 de base nos modelos XL, 512 nos do tipo 1.5; menos passos nos modelos turbo e lightning). Quem quiser mandar: `largura` e `altura` (viram múltiplos de 64, de 256 a 2048), `passos` (até 150) e `semente` (inteiro; sem ela a ponte sorteia e devolve).
- Resposta: `{ "id": "…" }`. Pedido errado: 400 com `{ "erro": "…" }`.

`GET /ponte/locais/imagem/<id>?depois=N&espera=20`

```json
{ "estado": "gerando", "passo": 12, "passos": 25, "semente": 176852365116656, "largura": 1344, "altura": 768,
  "proximo": 9, "fim": false, "erro": null, "imagem": null }
```

- Consulta longa, igual à do download. `estado`: `fila`, `carregando` (o modelo está indo para a memória; a primeira imagem demora mais por isso), `gerando`, `pronta`, `erro` ou `cancelada`.
- `passo` e `passos` contam o andamento quando o ComfyUI informa; se não informar, a imagem sai do mesmo jeito e o estado pula de `fila` para `pronta`.
- Com `pronta`, `imagem` traz `{ "tipo": "image/png", "tamanho": 1619664 }` e o arquivo sai em `GET /ponte/locais/imagem/<id>/arquivo`: os bytes da imagem, com o `content-type` certo. A resposta da ponte ao celular não tem o limite de tamanho dos pedidos, então a imagem vem inteira de uma vez.
- `DELETE /ponte/locais/imagem/<id>` → `{ "ok": true }`: cancela e interrompe a geração no ComfyUI. Depois disso o `id` deixa de existir.
- 404 quer dizer que a imagem não existe mais. A ponte cancela uma imagem que ninguém consulta há 5 minutos e apaga a imagem pronta depois de 10 minutos; o app deve buscar o arquivo logo.
- A imagem não fica guardada no computador: o ComfyUI a grava só na pasta temporária dele.
- Cinco minutos depois da última imagem, a ponte pede ao ComfyUI para soltar a memória de vídeo.
- Chamar `POST /ponte/locais/conversa` com um servidor `comfyui` volta 400: "Este modelo só gera imagem. Use-o em Criar mídia."

## Contexto no Ollama

O Ollama, sem pedir, abre o modelo com contexto pequeno (4 mil tokens em placa com menos de 24 GB). A ponte manda `num_ctx` em cada pedido: o tamanho que a conversa precisa, em degraus (8192, 16384, 32768…), até o teto do modelo. Se o modelo já está carregado com contexto suficiente, a ponte repete esse número para não recarregar. O `contexto` anunciado na lista é o menor entre o teto do modelo e 16384; dá para mudar esse número no `config.json`. Se o modelo já está carregado com mais do que isso, a lista anuncia o tamanho carregado. Até a 0.7.0 a lista anunciava o tamanho carregado mesmo quando era menor (8192 logo depois de uma pergunta curta), e o app barrava a conversa cedo demais; a 0.7.1 corrige.

## Servidores a mais

Em `~/.elizium-ponte/config.json`, no computador:

```json
{ "locais": { "contexto": 16384,
              "servidores": [ { "nome": "vLLM", "url": "http://127.0.0.1:8000", "tipo": "openai", "chave": "" },
                              { "nome": "ComfyUI", "url": "http://127.0.0.1:8189", "tipo": "comfyui", "pasta": "D:\\modelos\\checkpoints" } ] } }
```

`tipo`: `openai` (padrão), `ollama`, `lmstudio` ou `comfyui`. `chave` é opcional e fica só no computador. O endereço do Ollama também pode vir da variável `OLLAMA_HOST`. O ComfyUI na porta de sempre (8188) é achado sozinho. `pasta` só vale para `comfyui` e é opcional: a pasta de checkpoints, para quando a ponte não consegue perguntar ao próprio ComfyUI. Baixar e remover arquivos do ComfyUI só funcionam quando ele roda no mesmo computador da ponte.

## Testar no computador, sem celular

`node teste-locais.mjs lista` (e `consultar`, `baixar`, `remover`, `imagem`; o começo do arquivo mostra como) chama a mesma parte da ponte direto, contra os servidores ligados no computador.
