const Router = require('koa-router')
const route = new Router()
const { readFile, unlink } = require('mz/fs')
const getPayload = require('./lib/get-payload')
const { AccessFilter } = require('./auth')
const { newId, toId } = require('../lib/id-util')

route.post('/daises/',
    async ctx => {
        const payload = getPayload(ctx)
        let {
            insertedId
        } = await ctx.db.collection('dais').insertOne(
            Object.assign(
                {
                    login: Object.assign(
                        { user: payload.contact.email },
                        require('../lib/password').derive(payload.password)
                    )
                },
                getPayload(ctx),
                { password: undefined, created_at: new Date()}
            )
        )

        ctx.status = 200
        ctx.body = {
            id: insertedId
        }
    }
)

route.get('/daises/',
    AccessFilter('admin'),
    async ctx => {
        const daises = await ctx.db.collection('dais').find({ user: false }).toArray()
        ctx.status = 200
        ctx.body = daises.map(toId)
    }
)

route.post('/daises/:id',
    AccessFilter('admin'),
    async ctx => {
        const {
            activate,
            reject
        } = getPayload(ctx)
        
        if (activate) {
            const {
                login,
                session
            } = await ctx.db.collection('dais').findOne({ _id: ctx.params.id })
            if (!dais) {
                ctx.status = 404
                ctx.body = { error: 'not found' }
            }
            try {
                await ctx.db.collection('user').insertOne(
                    Object.assign(
                        login,
                        {
                            _id: login.user,
                            access: ['dais'],
                            reserved: false,
                            session: session,
                            school: null,
                            created: new Date()
                        }
                    )
                )
            } catch(e) {
                // duplicate
                ctx.status = 409
                ctx.body = { error: 'already exists' }
                return
            }
            await ctx.db.collection('dais').updateOne(
                { _id: ctx.params.id },
                { $set: { state: 'activated' } }
            )
            ctx.status = 200
        }

        if (reject) {
            await ctx.db.collection('dais').updateOne(
                { _id: ctx.params.id },
                { $set: { state: 'rejected' } }
            )
            ctx.status = 200
        }

        if (ctx.status === 200) {
            ctx.body = toId(
                await ctx.db.collection('dais').findOne({ _id: ctx.params.id }, { user: false })
            )
        }
    }
)

module.exports = {
    routes: route.routes()
}
