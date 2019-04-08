const Router = require('koa-router')
const route = new Router()
const { AccessFilter } = require('./auth')
const { toId } = require('../lib/id-util')

route.post('/committees/',
    async ctx => {
        let {
            insertedId
        } = await ctx.db.collection('committee').insertOne({
            ...ctx.request.body,
            created_at: new Date()
        })

        ctx.status = 200
        ctx.body = {
            id: insertedId
        }
    }
)

route.get('/committees/',
    AccessFilter('staff', 'finance', 'admin'),
    async ctx => {
        const committees = await ctx.db.collection('committee').find({}).toArray()
        ctx.status = 200
        ctx.body = committees.map(toId)
    }
)

module.exports = {
    routes: route.routes()
}
