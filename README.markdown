# stride-tabletop

Requires Docker, Stride API access, and my Game API server and Chess AI server.

To run, first create a file `.env` that contains the following contents:
```bash
export GAME_AI_URL='...'
export GAME_API_URL='...'
export GAME_API_KEY='...'
export STRIDE_CLIENT_ID='...'
export STRIDE_SECRET_ID='...'
```

Then run the following:
```bash
source .env && \
  docker build -t stride-tabletop . && \
  docker run --rm -it -p 8000:80 \
    -e "GAME_AI_URL=${GAME_AI_URL}" \
    -e "GAME_API_URL=${GAME_API_URL}" \
    -e "GAME_API_KEY=${GAME_API_KEY}" \
    -e "STRIDE_CLIENT_ID=${STRIDE_CLIENT_ID}" \
    -e "STRIDE_SECRET_ID=${STRIDE_SECRET_ID}" \
    -e "PORT=80" \
    --name stride-tabletop \
    stride-tabletop
```
