# Modelos do computador: contrato da ponte (0.9.2)

Serve para o app usar um modelo que roda no computador pareado: conversar, na aba Conversas, com um modelo de texto (Ollama, LM Studio, llama.cpp, Jan ou outro servidor que fale a API de chat da OpenAI); gerar imagem com um modelo do ComfyUI; e, desde a 0.8.0, baixar e remover modelos do computador pelo celular, com pesquisa pelo nome desde a 0.9.0. Não há chave: a ponte chama o servidor em 127.0.0.1 e o app fala só com a ponte, com a chave de pareamento de sempre.

Todos os endereços abaixo pedem `Authorization: Bearer <chave de pareamento>`, como o resto da ponte. A ponte que tem isso responde `"locais": true` em `GET /ponte/info`; se o campo faltar, a ponte é anterior à 0.7.0. Baixar, remover e gerar imagem existem a partir da 0.8.0: numa ponte mais antiga, os servidores da lista vêm sem os campos `baixa` e `remove`, e o app deve tratar a falta deles como "não pode". A pesquisa de modelos existe a partir da 0.9.0: o servidor que a tem vem com `"pesquisa": true`.

## O que foi conferido

- Ollama: conferido de verdade em 10/11/2026, pelo app do iPhone (no simulador) falando com a ponte 0.7.0 de um Windows com o Ollama 0.40.13 e os modelos qwen3:1.7b e gemma3:4b. Passaram: a lista (com o campo `imagem`, o detalhe e o tamanho), a resposta de texto com o raciocínio separado, a resposta sobre uma foto com o gemma3:4b (a foto reduzida passa de 400 KB, então o pedido foi em pedaços), os números de uso e o app parar a resposta no meio. No registro do Ollama (`server.log`) esse pedido aparece cancelado no meio da geração (`srv stop: cancel task`), 6 segundos depois de começar. Com a ponte 0.7.1, no mesmo dia e pelo mesmo caminho, o app passou a mostrar o limite de 16 384 tokens para o gemma3:4b (antes mostrava 8192) e respondeu a uma pergunta nova.
- LM Studio, llama.cpp, Jan e servidores do `config.json`: escritos pela documentação de cada um. Não foram testados com o programa de verdade.
- Baixar e remover modelos, e gerar imagem pelo ComfyUI: conferidos em 10/11/2026 com os programas de verdade, pelo `teste-locais.mjs` rodando no próprio Windows (ponte 0.8.0, Ollama 0.40.13, ComfyUI 0.45.0 com o sd_xl_base_1.0, placa RTX 4080 de 12 GB). Esse teste chama o código da ponte direto, sem passar pelo transmissor nem pelo app. Passaram: a lista com `baixa`, `remove`, `tipo` e `proporcoes`; a consulta de tamanho e de espaço livre; baixar o gemma3:270m (292 MB em 25 segundos, com o andamento, `conferindo` e `pronto`) e removê-lo; o nome que não existe na biblioteca (400 com a frase); gerar uma imagem 16:9 de 1344x768 em 28 segundos, com o andamento passo a passo, sem o texto do pedido dentro do PNG e sem arquivo novo na pasta de saída do ComfyUI; cancelar a imagem no meio (a fila do ComfyUI ficou vazia); baixar, listar e remover um `.safetensors` de teste pelo endereço do Hugging Face com `/blob/`; e cancelar um download do Ollama no meio. Nesse último apareceu um defeito, corrigido na 0.8.1: o Ollama deixava na pasta dele os pedaços do download interrompido (769 MB naquele caso), sem aparecer em lista nenhuma.
- A correção da 0.8.1: conferida em 10/11/2026 com o Ollama de verdade, no mesmo Windows. Um download do gemma3:1b cancelado no meio não deixou nenhum arquivo `-partial` na pasta do Ollama, e os outros modelos ficaram como estavam.
- O caminho inteiro, pelo app e pelo transmissor: conferido em 10/11/2026 pelo app do iPhone (no simulador) falando com a ponte 0.8.1 desse Windows. Passaram, na tela do app: a lista com os dois servidores (Ollama e ComfyUI); a consulta de tamanho e de espaço livre pelo nome (gemma3:270m, no Ollama) e pelo endereço https (um `.safetensors` do Hugging Face, no ComfyUI); baixar o gemma3:270m até o fim, com o andamento; cancelar um download no meio; remover um modelo, com a confirmação; e gerar uma imagem 16:9 com o sd_xl_base_1.0, com o andamento passo a passo e a imagem chegando inteira ao celular.
- A liberação da placa de vídeo: medida em 10/11/2026 no mesmo Windows, com o `nvidia-smi`. Em repouso, 264 MiB em uso; logo depois de uma imagem com o sd_xl_base_1.0, 6888 MiB; depois da liberação, 264 MiB de novo. A ponte 0.8.1 em uso foi conferida de forma indireta: dezesseis minutos depois da última imagem pedida pelo app, sem nenhum outro pedido no histórico do ComfyUI, a placa estava em 264 MiB, e o ComfyUI não descarrega o modelo sozinho. Não houve leitura logo depois dessa imagem. A leitura de 6888 MiB veio de uma geração pelo `teste-locais.mjs`, seguida do `/free` chamado à mão (nesse teste o temporizador não dispara, porque o programa termina antes dos 5 minutos). A ponte não escreve nada no registro quando libera a placa.
- Download do ComfyUI pelo endereço, começado no app: conferido em 10/11/2026 pelo app do iPhone (no simulador), pelo transmissor, falando com a ponte 0.8.2 de um Mac com processador Intel (macOS 26.5, Node 26.13, ComfyUI 0.45.0). Dois arquivos de 6,94 GB do Hugging Face foram pedidos na tela do app e seguidos até o fim: o `sd_xl_base_1.0.safetensors` em cerca de 9 minutos e o `sdxl_lightning_4step.safetensors` em cerca de 11 minutos (este com o processador ocupado gerando uma imagem). O app mostrou o tamanho e o espaço livre antes, o andamento, e o modelo novo na lista e em Criar mídia ao terminar. O SHA-256 de cada arquivo gravado é igual ao que o Hugging Face publica. Cancelar pelo app um download desses no meio apagou o arquivo parcial (`.baixando`) da pasta de checkpoints.
- O motivo da 0.8.2: nesse Mac, o download pelo endereço feito com o `fetch` do Node trazia o arquivo a cerca de 1 MB/s, enquanto o `curl` e o módulo `https` do Node traziam o mesmo arquivo a cerca de 7 MB/s, na mesma rede e na mesma hora. A 0.8.2 baixa com o módulo `https`. No Windows (Node 24.13.1) o `fetch` não era lento: medido no mesmo dia, naquele computador, com um `.safetensors` de 334,6 MB do Hugging Face pelo `teste-locais.mjs`, o download levou 20,2 segundos com a ponte 0.8.1 e 17,7 segundos com a 0.8.2, contra 36,9 segundos do `curl`, um depois do outro; a diferença entre as duas versões cabe na variação da rede. A lentidão foi vista só no Mac com o Node 26.13, e não se sabe se a causa é a versão do Node ou o macOS.
- No Mac com processador Intel, no mesmo dia e pelo app: a lista do Ollama 0.40.16 (qwen3:1.7b e gemma3:4b) e uma pergunta de texto respondida pelo qwen3:1.7b. O ComfyUI roda ali só no processador (`--cpu`): o PyTorch recusa a aceleração da Apple (MPS) em Mac com Intel. Uma imagem 16:9 com o sd_xl_base_1.0 (25 passos) levou cerca de 40 segundos por passo, 17 minutos e 47 segundos no ComfyUI, e chegou ao app, que esperou o tempo todo mostrando o passo. Com o sdxl_lightning_4step (os 6 passos que a ponte usa para nomes com `lightning`), 190 segundos, e a imagem chegou ao app. Não conferido nesse Mac: a pergunta com foto, parar uma resposta no meio, baixar pelo nome no Ollama, remover um modelo e cancelar uma imagem no meio.
- A pesquisa de modelos (0.9.0): conferida em 10/11/2026 nesse mesmo Mac, de dois jeitos. Pelo `teste-locais.mjs`, contra os sites de verdade: a pesquisa do Ollama (`qwen` trouxe a família Qwen, o texto vazio trouxe 14 modelos e um nome inventado voltou vazio); as variantes do qwen3 (nove, com a 1.7b marcada como instalada) e do gemma3; o nome que não existe e o nome inválido (400 com a frase); a pesquisa de imagem (`juggernaut`, `sdxl`, `dreamshaper`, `realistic vision` e o texto vazio); os arquivos do RunDiffusion/Juggernaut-XL-v9 (um, de 7,11 GB) e do ByteDance/SDXL-Lightning (quatro, com o de 4 passos marcado como instalado); e um repositório que não existe e repositórios só com LoRA ou refinador (400 com a frase). E pelo app do iPhone (no simulador), pelo transmissor: as sugestões ao abrir; a lista mudando enquanto o nome é escrito (`qw`, depois `qwen3`); a página de variantes com o tamanho e o aviso de que a 1.7b já está no computador; a confirmação com o tamanho exato e o espaço livre; um download do qwen3:0.6b começado pela pesquisa e cancelado logo depois (o Ollama ficou com os dois modelos de antes, sem pedaços); a pesquisa de imagem (`jugg`), a página de arquivos e a confirmação de 7,11 GB, recusada; o endereço https escrito no campo da pesquisa, com a confirmação de 6,94 GB, recusada; o nome escrito com a etiqueta (`qwen3:0.6b`), que mostra a família e a opção de baixar o nome escrito; e o nome que não existe. Não conferido: um download do ComfyUI começado pela pesquisa e levado até o fim, a leitura da tela pelo VoiceOver, um iPhone de verdade e a pesquisa numa ponte de Windows.
- A pesquisa no Hugging Face para o Ollama (0.9.2): conferida em 11/11/2026 nesse mesmo Mac (Ollama 0.40.16), de dois jeitos. Pelo `teste-locais.mjs`, contra os sites de verdade: a pesquisa com as duas origens (`qwen3 abliterated` e `smollm2` trouxeram 20 resultados do site do Ollama e 20 do Hugging Face; o texto vazio ou de uma letra só trouxe só os do Ollama; o texto começado por `hf.co/`, só os do Hugging Face); as variantes do unsloth/Qwen3-0.6B-GGUF (26, com a Q4_K_M na frente), do bartowski/SmolLM2-135M-Instruct-GGUF (23) e de um modelo que vê imagem, o huihui-ai/Huihui-Qwen3.8-27B-abliterated-GGUF (48); um repositório com parte dos arquivos partidos (Qwen/Qwen2.5-7B-Instruct-GGUF, que ficou só com as duas variantes inteiras); o repositório todo partido, o sem GGUF, o que não existe e o nome inválido (400 com a frase); a consulta de tamanho pelo registro do Hugging Face (105 455 694 bytes na Q4_K_M do SmolLM2-135M; 17 482 462 753 bytes na do modelo de 27B, já com a peça de imagem), com a etiqueta em minúsculas, a variante que não existe, a variante partida e o repositório fechado ou sem GGUF (400 com a frase); e um download de verdade do `hf.co/bartowski/SmolLM2-135M-Instruct-GGUF:Q4_K_M` até `pronto`. E pelo app do iPhone (no simulador), pelo transmissor: a pesquisa `smollm2` com a seção Ollama seguida da seção Hugging Face; a página de variantes com os tamanhos e o aviso de que a Q4_K_M já estava no computador; a confirmação com o tamanho exato (88,2 MB) e o espaço livre; o download da IQ3_XS até o fim, com o andamento; uma resposta de texto desse modelo na conversa; e a remoção dos dois modelos de teste pelo app. E numa ponte de Windows (JOAO-NEW, Windows 11), no mesmo dia, pela sessão que cuida da ponte de lá e só pelo `teste-locais.mjs`, que chama o código direto, sem passar pela ponte ligada: a pesquisa `smollm2` com 20 resultados do site do Ollama seguidos de 20 do Hugging Face; a de uma letra só, com os do Ollama apenas; as 23 variantes do bartowski/SmolLM2-135M-Instruct-GGUF, com a Q4_K_M na frente; a consulta de tamanho (105 455 694 bytes); a variante que não existe (400 com a frase); e a pesquisa do ComfyUI com `origem` `huggingface`. Não conferido: o download de um modelo do Hugging Face que vê imagem ou de um modelo grande, a leitura da tela pelo VoiceOver, um iPhone de verdade, o app do Android contra uma ponte 0.9.2 de verdade e, no Windows, a pesquisa pelo app (pelo transmissor) e o download de um modelo do Hugging Face.

## Listar

`GET /ponte/locais`

```json
{ "servidores": [
  { "id": "ollama", "nome": "Ollama", "tipo": "ollama", "baixa": "nome", "remove": true, "pesquisa": true,
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
- `pesquisa` (0.9.0) diz se dá para pesquisar modelos para baixar nesse servidor (veja "Pesquisar um modelo"). Campo ausente ou `false`: o app pede o nome ou o endereço escrito à mão, como antes.
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

## Pesquisar um modelo (0.9.0)

Serve para a pessoa achar o modelo pelo nome, com sugestões enquanto escreve, em vez de digitar o nome exato ou colar um endereço. Só em servidor com `"pesquisa": true`.

`POST /ponte/locais/pesquisar`

```json
{ "servidor": "ollama", "texto": "qwen" }
```

```json
{ "servidor": "ollama", "texto": "qwen", "resultados": [
  { "id": "qwen3", "nome": "qwen3",
    "descricao": "Qwen3 is the latest generation of large language models in Qwen series…",
    "detalhe": "0.6b, 1.7b, 4b, 8b, 14b, 30b, 32b, 235b · raciocina · 43,1 mi de downloads",
    "imagem": false, "raciocinio": true, "downloads": 43077266 } ] }
```

- `texto` é o que a pessoa escreveu até agora (até 80 letras). Vazio devolve os modelos que o site mostra primeiro. O app pode chamar a cada pausa na digitação; a ponte guarda cada resposta por 10 minutos.
- `resultados` vem na ordem do site, até 30. Lista vazia quer dizer que nada combinou. `id` é o que o app manda a `/opcoes`; `nome` é o que aparece na tela.
- Desde a 0.9.1 a pesquisa do Ollama traz também os modelos que as pessoas publicam no site com a conta delas, e não só os da biblioteca do Ollama. Eles vêm com `"comunidade": true`, com `id` e `nome` na forma `pessoa/modelo` (por exemplo `huihui_ai/qwen3-abliterated`) e com `da comunidade` no começo do `detalhe`. É por aí que aparecem variações que a biblioteca não tem, como as `abliterated`. O Ollama não confere esses modelos; a ponte também não. Em ponte mais antiga o campo não vem.
- Desde a 0.9.2 a pesquisa do Ollama traz também os modelos GGUF do Hugging Face, que o Ollama baixa pelo nome `hf.co/<pessoa>/<repositório>:<variante>`. Eles vêm depois dos do site do Ollama, até 20, dos mais baixados para os menos, com `id` na forma `hf.co/pessoa/repositório`, `nome` na forma `pessoa/repositório`, `do Hugging Face` no começo do `detalhe` (seguido do número de variantes, de `vê imagem` quando o repositório traz a peça de imagem, e dos downloads), `descricao` vazia e `"comunidade": true`: o Ollama não confere esses modelos, e a ponte também não. O Hugging Face só é consultado quando o texto tem pelo menos 2 letras. Texto começado por `hf.co/` ou `huggingface.co/` (com ou sem `https://`) pesquisa só o Hugging Face. Ficam de fora das sugestões os modelos que pedem login, os marcados como conteúdo adulto, os que não são de conversa (imagem, vetores, voz), os repositórios sem nenhum arquivo GGUF inteiro na raiz (os partidos em vários pedaços, que o Ollama não baixa) e os nomes que o Ollama não aceita (pessoa com ponto no nome, ou parte com mais de 80 letras). Se um dos dois sites estiver fora do ar, vêm os resultados do outro; o erro só volta quando os dois falham.
- `origem` (0.9.2) diz de que site o resultado veio: `"ollama"` ou `"huggingface"` (no ComfyUI, sempre `"huggingface"`). O app pode usar o campo para separar a lista em grupos; o do iPhone mostra as seções Ollama e Hugging Face quando a resposta traz as duas origens. Em ponte mais antiga o campo não vem.
- `descricao` vem do site (em inglês, no Ollama) e pode vir vazia. `detalhe` é uma linha curta pronta para mostrar. `imagem` e `raciocinio` têm o mesmo sentido da lista de modelos. `downloads` é um número, ou `null`.
- No Ollama, a ponte lê a página pública de pesquisa do site (`ollama.com/search`), porque o Ollama não tem uma API de pesquisa. Se o texto trouxer a etiqueta da variante (`qwen3:0.6b`), a ponte pesquisa só o nome, que é o que o site conhece. Ficam de fora os modelos que só rodam na nuvem do Ollama e os de vetores. Se o site mudar a página, a pesquisa volta vazia (a ponte anota isso no registro dela) e o nome escrito à mão continua valendo.
- No ComfyUI, a pesquisa usa a API pública do Hugging Face, entre os modelos de texto para imagem, dos mais baixados para os menos. Só entram repositórios abertos, da família Stable Diffusion (1.x, 2.x e XL), com pelo menos um arquivo `.safetensors` de modelo inteiro na raiz. Ficam de fora LoRA, ControlNet, VAE, modelos de outras famílias (Flux, Qwen Image, SD3…), que o fluxo de imagem da ponte não sabe rodar a partir de um arquivo só, e os repositórios que o Hugging Face marca como conteúdo adulto. O que a pesquisa não sugere continua entrando pelo endereço do arquivo.
- Erro: 400 com `{ "erro": "…" }`, frase pronta (computador sem internet, site fora do ar).

Escolhido um resultado, o app pergunta o que dá para baixar dele:

`POST /ponte/locais/opcoes`

```json
{ "servidor": "ollama", "modelo": "qwen3" }
```

```json
{ "servidor": "ollama", "modelo": "qwen3", "opcoes": [
  { "nome": "qwen3:1.7b", "alvo": "qwen3:1.7b", "tamanho": 1400000000, "detalhe": "contexto 40K · texto", "instalado": true },
  { "nome": "qwen3:4b", "alvo": "qwen3:4b", "tamanho": 2500000000, "detalhe": "contexto 256K · texto", "instalado": false } ] }
```

- `modelo` é o `id` de um resultado da pesquisa. No Ollama as opções são as variantes do modelo (`qwen3:4b`), tiradas da página dele no site; num modelo da comunidade (0.9.1) vêm da página de etiquetas dele, que traz todas as compressões (até 40); num resultado do Hugging Face (0.9.2, `hf.co/pessoa/repositório`) são os arquivos GGUF inteiros da raiz do repositório, um por compressão, até 60, com a Q4_K_M na frente e depois do menor para o maior: `nome` é a etiqueta da compressão (`Q4_K_M`) ou, quando a etiqueta não basta para distinguir o arquivo, o nome inteiro do arquivo, e `alvo` é `hf.co/pessoa/repositório:<nome>`; no ComfyUI são os arquivos de modelo inteiro do repositório (acima de 1,3 GB).
- `alvo` é o que o app manda, sem mexer, a `/consultar` e a `/baixar`: como `modelo` num servidor com `"baixa": "nome"`, como `endereco` num servidor com `"baixa": "endereco"`.
- `tamanho` em bytes, ou `null`. No Ollama é o número arredondado que o site mostra; o tamanho exato e o espaço livre vêm de `/consultar`, que o app chama antes de confirmar o download. Até a 0.9.0, `/consultar` devolvia `tamanho` nulo para todo modelo do Ollama com ponto no nome (`qwen3.8`, `llama3.2`), porque tomava o ponto por endereço de outro registro; a 0.9.1 corrige. Num modelo do Hugging Face (0.9.2) é o tamanho exato do arquivo do modelo; quando o modelo vê imagem, o Ollama baixa junto a peça de imagem (mmproj), e o total certo é o de `/consultar`.
- `instalado` diz se essa opção já está no computador. `detalhe` pode vir vazio.
- Nome que não existe, repositório fechado ou sem arquivo de modelo inteiro: 400 com a frase. Vale também para o Hugging Face pelo Ollama: repositório que não existe ou pede login, sem arquivo GGUF, ou com todos os arquivos partidos em vários pedaços.

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
- Desde a 0.9.2, para um nome `hf.co/pessoa/repositório:variante` o tamanho vem do registro do Hugging Face (o mesmo que o Ollama consulta para baixar) e já soma a peça de imagem dos modelos que veem imagem; antes vinha `null`. A variante pode ser a etiqueta da compressão, em maiúsculas ou minúsculas, ou o nome do arquivo. Variante que não existe, variante partida em vários arquivos, repositório sem GGUF e repositório que não existe ou pede login: 400 com a frase, antes de o download começar. `instalado` compara os nomes sem diferenciar maiúsculas de minúsculas.
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

`node teste-locais.mjs lista` (e `pesquisar`, `opcoes`, `consultar`, `baixar`, `remover`, `imagem`; o começo do arquivo mostra como) chama a mesma parte da ponte direto, contra os servidores ligados no computador.
