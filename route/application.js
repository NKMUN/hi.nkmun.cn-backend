const Router = require('koa-router')
const route = new Router()
const { AccessFilter } = require('./auth')
const getPayload = require('./lib/get-payload')
const { Config } = require('./config')

route.post('/applications/',
    Config,
    async ctx => {
        let payload = getPayload(ctx)

        if ( ! ctx.config.apply ) {
            ctx.status = 410
            ctx.body = { error: 'gone' }
            return
        }

        if ( ! (payload.school && payload.school.name) ) {
            ctx.status = 400
            ctx.body = { error: 'bad request' }
            return
        }

        let application = Object.assign(
            payload,
            { _id: payload.school.name }
        )

        try{
            await ctx.db.collection('application').insertOne( application )
            ctx.status = 200
            ctx.body = { message: 'accepted' }
        } catch(e) {
            ctx.status = 409
            ctx.body = { error: 'already exists' }
        }

    }
)

route.get('/applications/',
    AccessFilter('admin'),
    async ctx => {
        ctx.status = 200
        ctx.body = await ctx.db.collection('application').aggregate([
            { $project: {
                _id: 0,
                id: '$_id',
                name: '$school.name',
                processed: { $ifNull: ['$processed', false] }
            } }
        ]).toArray()
    }
)

route.get('/applications/:id',
    AccessFilter('admin'),
    async ctx => {
        let result = await ctx.db.collection('application').findOne({ _id: ctx.params.id })
        if (result) {
            // rename _id -> id
            result.id = result._id
            delete result._id
            ctx.status = 200
            ctx.body = result
        }else{
            ctx.status = 404
            ctx.body = { error: 'not found' }
        }
    }
)

route.patch('/applications/:id',
    AccessFilter('admin'),
    async ctx => {
        let {
            modifiedCount
        } = await ctx.db.collection('application').updateOne(
            { _id: ctx.params.id },
            { $set: getPayload(ctx) }
        )
        if (modifiedCount) {
            ctx.status = 200
            ctx.body = { }
        } else {
            ctx.status = 404
            ctx.body = { error: 'not found' }
        }
    }
)

module.exports = {
    routes: route.routes()
}
