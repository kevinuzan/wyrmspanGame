# Wyrmspan Online

Wyrmspan para 2–5 jogadores, cada um no seu aparelho. Salas por código, WebSocket, sem banco de dados.

## Rodar local
```
npm install
npm start        # http://localhost:3000
```
Abra duas abas (ou dois aparelhos na mesma rede), crie a sala numa e entre com o código na outra.

## Deploy no Railway
1. Suba esta pasta para um repositório no GitHub.
2. Railway → New Project → Deploy from GitHub repo.
3. Em Settings → Networking → Generate Domain. Não precisa de variável de ambiente nem de banco.
4. Mande o link `https://seu-dominio/?sala=CODIGO` (botão "Copiar link de convite") para o outro jogador.

## Atualizar as cartas
Edite `public/cartas.json` (instruções no campo `_leiame`), faça commit e push. O Railway publica sozinho e a próxima partida já usa as cartas novas.

## Como funciona
- `server.mjs`: serve `public/` e gerencia as salas em memória (`/ws`). Se o servidor reiniciar (novo deploy), os navegadores reconstroem a sala sozinhos.
- O jogador da vez roda as regras no próprio navegador e envia o estado; o outro recebe e desenha. Quando uma carta faz o oponente decidir algo, o pop-up aparece na tela dele.
- Cada jogador só vê a própria mão. Recarregar a página ou perder a conexão não perde a partida.
