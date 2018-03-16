const Router = require('koa-router')
const route = new Router()
const { AccessFilter, TokenParser } = require('./auth')
const getPayload = require('./lib/get-payload')
const { Config } = require('./config')
const { toId, newId } = require('../lib/id-util')
const { LogOp } = require('../lib/logger')

async function getHotel(ctx, id) {
    return toId( await ctx.db.collection('hotel').findOne({ _id: id }) )
}

route.get('/hotels/',
    AccessFilter('leader', 'individual', 'staff.accommodation'),
    async ctx => {
        ctx.status = 200
        ctx.body = (await ctx.db.collection('hotel').find({}).toArray()).map( toId )
    }
)

route.get('/hotels/:id',
    AccessFilter('admin'),
    async ctx => {
        ctx.status = 200
        ctx.body = getHotel(ctx, ctx.params.id)
    }
)

route.post('/hotels/',
    AccessFilter('admin'),
    async ctx => {
        let {
            name,
            type,
            price = 0,
            notBefore = null,
            notAfter = null,
            roomshareInitiatorRate = 1,
            roomshareRecipientRate = 0,
            stock = 0
        } = getPayload(ctx)

        // hotel spec
        const {
            insertedId
        } = await ctx.db.collection('hotel').insertOne({
            _id: newId(),
            name,
            type,
            price,
            notBefore,
            notAfter,
            roomshareInitiatorRate,
            roomshareRecipientRate,
            stock,
            available: stock
        })

        ctx.status = 200
        ctx.body = await getHotel(ctx, insertedId)
    }
)

route.delete('/hotels/:id',
    AccessFilter('admin'),
    async ctx => {
        await ctx.db.collection('hotel').deleteOne({ _id: ctx.params.id })

        const {
            deletedCount
        } = await ctx.db.collection('reservation').deleteMany({ hotel: ctx.params.id })

        ctx.status = 200
        ctx.body = { deleted: deletedCount }
    }
)

route.patch('/hotels/:id',
    AccessFilter('admin'),
    async ctx => {
        const {
            stock: target
        } = getPayload(ctx)

        if (target !==undefined) {
            const {
                stock = 0,
                available = 0
            } = await ctx.db.collection('hotel').findOne({ _id: ctx.params.id }, { _id: 0, stock: 1, available: 1 })

            // try not to decrease available beyond zero
            const delta = Math.max( target-stock, -available )
            await ctx.db.collection('hotel').updateOne(
                { _id: ctx.params.id },
                { $inc: { stock: delta, available: delta } }
            )
        }

        ctx.status = 200
        ctx.body = await getHotel(ctx, ctx.params.id)
    }
)

module.exports = {
    routes: route.routes()
}
