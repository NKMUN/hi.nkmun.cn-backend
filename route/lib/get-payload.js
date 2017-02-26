module.exports = (ctx) =>
    ctx.is('multipart') ? ctx.request.body.fields : ctx.request.body
