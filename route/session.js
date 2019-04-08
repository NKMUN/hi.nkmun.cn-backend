const Router = require('koa-router')
const route = new Router()
const { AccessFilter } = require('./auth')
const { toId, fromId } = require('../lib/id-util')

async function Sessions(ctx, next) {
    if (!ctx.sessions)
        ctx.sessions = await ctx.db.collection('session').find({ }).toArray()

    if (next)
        await next()
}

route.get('/sessions/',
    AccessFilter('staff'),
    Sessions,
    async ctx => {
        ctx.status = 200
        ctx.body = ctx.sessions.map( toId )
    }
)

route.put('/sessions/',
    AccessFilter('staff'),
    async ctx => {
        await ctx.db.collection('session').remove({})
        await ctx.db.collection('session').insertMany( ctx.request.body.map(fromId) )
        await Sessions(ctx)
        ctx.status = 200
        ctx.body = ctx.sessions.map( toId )
    }
)

module.exports = {
    Sessions,
    routes: route.routes()
}
