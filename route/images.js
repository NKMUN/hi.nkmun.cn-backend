const Router = require('koa-router')
const route = new Router()
const { readFile: _readFile, unlink: _unlink } = require('fs')
const { promisify } = require('util')
const readFile = promisify(_readFile)
const unlink = promisify(_unlink)
const { newId } = require('../lib/id-util')
const sharp = require('sharp')

function tryParseJSON(str) {
    if (!str) return null
    try {
        return JSON.parse(str)
    } catch(e) {
        return null
    }
}

route.post('/images/',
    async ctx => {
        const { db } = ctx
        if ( ! ctx.is('multipart') ) {
            ctx.status = 415
            ctx.body = { status: false, message: 'Expect multipart/form-data' }
            return
        }

        const { path, type, size } = ctx.request.files.file
        const meta = tryParseJSON(ctx.request.body.meta)
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
            meta
        })

        await unlink(path)

        ctx.status = 200
        ctx.body = {
            id: insertedId
        }
    }
)

const SIZE_MAP = {
    tiny: 160,
    mini: 240,
    small: 480,
    medium: 720,
    large: 1280,
    raw: -1
}

const FORMAT_MAP = {
    'jpg': {
        format: 'jpeg',
        mime: 'image/jpeg',
        options: {
            progressive: true
        }
    }
}

function respondWithImage(ctx, {
    body,
    mime,
    size,
    createdAt = new Date(),
    cached = false
} = {}) {
    ctx.status = 200
    ctx.set('Content-Type', mime)
    ctx.set('Content-Length', size)
    ctx.set('Cache-Control', 'public, max-age=31536000')  // cache 1 year
    ctx.set('X-Created-At', new Date(createdAt).toISOString())
    ctx.set('X-Image-Cache', cached ? 'HIT' : 'MISS')
    ctx.body = body
}

route.get('/images/:id',
    async ctx => {
        const {
            size = "small",
            format = "jpg",
            cache = "1"
        } = ctx.query
        if ( ! SIZE_MAP[size] ) {
            ctx.status = 400
            ctx.body = { error: 'bad args', message: `unsupported size: ${size}` }
            return
        }
        if ( ! FORMAT_MAP[format] ) {
            ctx.status = 400
            ctx.body = { error: 'bad args', message: `unsupported format: ${format}` }
            return
        }

        const _id = ctx.params.id

        const meta = await ctx.db.collection('image').findOne(
            { _id },
            { created: true }
        )

        if ( ! meta ) {
            ctx.status = 404
            ctx.body = { error: 'not found' }
            return
        }

        if ( size === 'raw' ) {
            const image = await ctx.db.collection('image').findOne(
                { _id },
                { buffer: true, mime: true, size: true }
            )
            return respondWithImage(ctx, {
                body: image.buffer.buffer,
                mime: image.mime,
                size: image.size,
                createdAt: meta.created
            })
        }

        // check for cached result
        const cacheKey = `cached.${size}.${format}`
        const cachedResult = await ctx.db.collection('image').findOne(
            { _id: ctx.params.id, [cacheKey]: {$exists: true} },
            { [cacheKey]: true, created: true }
        )
        if (cachedResult) {
            const mongoBuffer = cachedResult.cached[size][format]
            return respondWithImage(ctx, {
                body: mongoBuffer.buffer,
                mime: FORMAT_MAP[format].mime,
                size: mongoBuffer.length(),
                createdAt: meta.created,
                cached: true
            })
        } else {
            // compress, optionally store, then respond
            const image = await ctx.db.collection('image').findOne(
                { _id },
                { buffer: true }
            )
            const resultBuffer = await sharp(image.buffer.buffer, {failOnError: false})
                .resize(SIZE_MAP[size], SIZE_MAP[size])
                .resize({ fit: 'inside', withoutEnlargement: true })
                .toFormat(FORMAT_MAP[format].format, FORMAT_MAP.options)
                .toBuffer()
            respondWithImage(ctx, {
                body: resultBuffer,
                mime: FORMAT_MAP[format].mime,
                size: resultBuffer.length,
                createdAt: meta.created
            })
            if (cache !== "0" && cache !== "false") {
                // do not wait for db write
                ctx.db.collection('image').updateOne(
                    { _id },
                    { $set: { [cacheKey]: resultBuffer } }
                )
            }
            return
        }
    }
)

module.exports = {
    routes: route.routes()
}
