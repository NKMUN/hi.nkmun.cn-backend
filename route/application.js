const Router = require('koa-router')
const route = new Router()
const { AccessFilter } = require('./auth')
const getPayload = require('./lib/get-payload')
const { Config } = require('./config')
const { toId, newId } = require('../lib/id-util')
const { LogOp } = require('../lib/logger')

route.post('/applications/',
    Config,
    LogOp('application', 'submit'),
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

        ctx.log.application = payload

        let exists = await ctx.db.collection('application').findOne({ "school.name": payload.school.name })

        if ( exists ) {
            ctx.status = 409
            ctx.body = { error: 'already exists' }
        } else {
            await ctx.db.collection('application').insert(
                Object.assign(
                    payload,
                    { _id: newId(), created: new Date() }
                )
            )
            ctx.status = 200
            ctx.body = { message: 'accepted' }
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
            ctx.status = 200
            ctx.body = toId(result)
        }else{
            ctx.status = 404
            ctx.body = { error: 'not found' }
        }
    }
)

route.patch('/applications/:id',
    AccessFilter('admin'),
    LogOp('application', 'seat-alloc'),
    async ctx => {
        let {
            modifiedCount
        } = await ctx.db.collection('application').updateOne(
            { _id: ctx.params.id },
            { $set: getPayload(ctx),
              $currentDate: { lastModified: { $type: 'date' } } }
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

route.delete('/applications/:id',
    AccessFilter('admin'),
    LogOp('application', 'nuke'),
    async ctx => {
        let {
            deletedCount
        } = await ctx.db.collection('application').deleteOne({ _id: { $eq: ctx.params.id } })
        if (deletedCount) {
            ctx.status = 200
            ctx.body = { message: 'nuked' }
        } else {
            ctx.status = 404
            ctx.body = { error: 'not found' }
        }
    }
)

module.exports = {
    routes: route.routes()
}
