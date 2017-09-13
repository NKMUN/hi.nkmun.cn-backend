const Router = require('koa-router')
const route = new Router()
const { readFile, unlink } = require('mz/fs')
const getPayload = require('./lib/get-payload')
const { AccessFilter } = require('./auth')
const { newId, toId } = require('../lib/id-util')

route.post('/committees/',
    async ctx => {
        let {
            insertedId
        } = await ctx.db.collection('committee').insertOne(
            Object.assign(
                {},
                getPayload(ctx),
                { created_at: new Date()}
            )
        )

        ctx.status = 200
        ctx.body = {
            id: insertedId
        }
    }
)

route.get('/committees/',
    AccessFilter('admin', 'root'),
    async ctx => {
        const committees = await ctx.db.collection('committee').find({}).toArray()
        ctx.status = 200
        ctx.body = committees.map(toId)
    }
)

module.exports = {
    routes: route.routes()
}