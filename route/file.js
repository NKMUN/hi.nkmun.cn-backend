const Router = require('koa-router')
const route = new Router()
const { readFile, unlink } = require('mz/fs')
const getPayload = require('./lib/get-payload')
const { AccessFilter, TokenAccessFilter } = require('./auth')
const { newId } = require('../lib/id-util')
const { sign } = require('jsonwebtoken')
const sharp = require('sharp')
const contentDisposition = require('content-disposition')

function UploadFile(meta = {}) {
    return async ctx => {
        const { db } = ctx
        if ( ! ctx.is('multipart') ) {
            ctx.status = 415
            ctx.body = { status: false, message: 'Expect multipart/form-data' }
            return
        }

        let { path, type, size, name } = ctx.request.body.files.file
        if ( size > 20*1024*1024 ) {
            ctx.status = 400
            ctx.body = { error: 'too large' }
            return
        }

        // sanitize meta
        delete meta._id
        delete meta.id
        delete meta.created
        delete meta.size
        delete meta.name
        delete meta.mime
        delete meta.buffer

        let {
            insertedId
        } = await ctx.db.collection('file').insertOne({
            _id: newId(),
            created: new Date(),
            size,
            name,
            mime: type,
            buffer: await readFile(path),
            ...meta
        })

        await unlink(path)

        ctx.status = 200
        ctx.body = {
            id: insertedId,
            name
        }
    }
}

function GetFile(_id) {
    return async ctx => {
        const meta = await ctx.db.collection('file').findOne(
            { _id },
            { created: true }
        )

        if ( ! meta ) {
            ctx.status = 404
            ctx.body = { error: 'not found' }
            return
        }

        const {
            original_name = false
        } = ctx.query

        const file = await ctx.db.collection('file').findOne(
            { _id },
            { buffer: true, mime: true, size: true, name: true }
        )

        ctx.status = 200
        ctx.set('Content-Type', file.mime)
        ctx.set('Content-Length', file.size)
        ctx.set('X-Created-At', file.created)
        if (original_name)
            ctx.set('Content-Disposition', contentDisposition(file.name))
        ctx.body = file.buffer.buffer
    }
}

function signFile(secret, id, expires = '1h') {
    // match TokenAccessFilter's token format
    return sign(
        { path: `/files/${id}` },
        secret,
        { expiresIn: expires }
    )
}

route.get('/files/:id',
    TokenAccessFilter('root' ,'admin'),
    async ctx => {
        await GetFile(ctx.params.id)(ctx)
    }
)

module.exports = {
    UploadFile,
    GetFile,
    signFile,
    routes: route.routes()
}
