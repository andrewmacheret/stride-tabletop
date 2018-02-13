FROM node:8-alpine

WORKDIR /app

ADD . .

CMD [ "node", "app.js" ]
