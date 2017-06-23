const Router = require('koa-router')
const route = new Router()
const { readFile, unlink } = require('mz/fs')
const getPayload = require('./lib/get-payload')
const { AccessFilter } = require('./auth')
const { newId } = require('../lib/id-util')

route.post('/images/',
    async ctx => {
        const { db } = ctx
        if ( ! ctx.is('multipart') ) {
            ctx.status = 415
            ctx.body = { status: false, message: 'Expect multipart/form-data' }
            return
        }

        let { path, type, size } = ctx.request.body.files.file
        if ( size > 20*1024*1024 ) {
            ctx.status = 400
            ctx.body = { error: 'too large' }
            return
        }

        let {
            insertedId
        } = await ctx.db.collection('image').insertOne({
            _id: newId(),
            created: new Date(),
            size,
            mime: type,
            buffer: await readFile(path),
        })

        await unlink(path)

        ctx.status = 200
        ctx.body = {
            id: insertedId
        }
    }
)

route.get('/images/:id',
    AccessFilter('admin', 'root'),
    async ctx => {

    }
)

module.exports = {
    routes: route.routes()
}
