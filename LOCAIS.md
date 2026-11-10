# Modelos do computador: contrato da ponte (0.7.0)

Serve para o app usar, na aba Conversas, um modelo que roda no computador pareado (Ollama, LM Studio, llama.cpp, Jan ou outro servidor que fale a API de chat da OpenAI). Não há chave: a ponte chama o servidor em 127.0.0.1 e o app fala só com a ponte, com a chave de pareamento de sempre.

Todos os endereços abaixo pedem `Authorization: Bearer <chave de pareamento>`, como o resto da ponte. A ponte que tem isso responde `"locais": true` em `GET /ponte/info`; se o campo faltar, a ponte é anterior à 0.7.0.

## O que foi conferido

- Ollama: conferido de verdade em 10/11/2026, pelo app do iPhone (no simulador) falando com a ponte 0.7.0 de um Windows com o Ollama 0.40.13 e os modelos qwen3:1.7b e gemma3:4b. Passaram: a lista (com o campo `imagem`, o detalhe e o tamanho), a resposta de texto com o raciocínio separado, a resposta sobre uma foto com o gemma3:4b (a foto reduzida passa de 400 KB, então o pedido foi em pedaços), os números de uso e o app parar a resposta no meio. Não foi olhado no computador se o Ollama parou de gerar na hora em que o app cancelou.
- LM Studio, llama.cpp, Jan e servidores do `config.json`: escritos pela documentação de cada um. Não foram testados com o programa de verdade.
- Gerar imagem com modelo local: não existe nesta versão. O campo `tipo` dos modelos vale sempre `"texto"`; `"imagem"` fica reservado.

## Listar

`GET /ponte/locais`

```json
{ "servidores": [
  { "id": "ollama", "nome": "Ollama", "tipo": "ollama",
    "modelos": [
      { "id": "gemma3:4b", "nome": "gemma3:4b", "tipo": "texto",
        "imagem": true, "raciocinio": false,
        "contexto": 16384, "contextoMaximo": 131072,
        "tamanho": 3338801804, "detalhe": "4.3B · Q4_K_M", "carregado": false } ] } ] }
```

- Só aparecem os servidores que responderam agora. Lista vazia quer dizer: nenhum servidor de modelos ligado neste computador.
- Um servidor ligado sem nenhum modelo aparece com `"modelos": []`.
- `id` do servidor: `ollama`, `lmstudio`, `llamacpp`, `jan`, ou `config1`, `config2`… para os do `config.json`. O app guarda e devolve esse `id`; nunca manda endereço.
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

## Contexto no Ollama

O Ollama, sem pedir, abre o modelo com contexto pequeno (4 mil tokens em placa com menos de 24 GB). A ponte manda `num_ctx` em cada pedido: o tamanho que a conversa precisa, em degraus (8192, 16384, 32768…), até o teto do modelo. Se o modelo já está carregado com contexto suficiente, a ponte repete esse número para não recarregar. O `contexto` anunciado na lista é o menor entre o teto do modelo e 16384; dá para mudar esse número no `config.json`. Se o modelo já está carregado com mais do que isso, a lista anuncia o tamanho carregado. Até a 0.7.0 a lista anunciava o tamanho carregado mesmo quando era menor (8192 logo depois de uma pergunta curta), e o app barrava a conversa cedo demais; a 0.7.1 corrige.

## Servidores a mais

Em `~/.elizium-ponte/config.json`, no computador:

```json
{ "locais": { "contexto": 16384,
              "servidores": [ { "nome": "vLLM", "url": "http://127.0.0.1:8000", "tipo": "openai", "chave": "" } ] } }
```

`tipo`: `openai` (padrão), `ollama` ou `lmstudio`. `chave` é opcional e fica só no computador. O endereço do Ollama também pode vir da variável `OLLAMA_HOST`.
