const Router = require('koa-router')
const route = new Router()
const { AccessFilter } = require('./auth')

route.post('/initialize',
    AccessFilter('root'),
    async ctx => {
        const { db } = ctx

        // preserve reserved users
        let users = await db.collection('user').find({ reserved: true }).toArray()

        // drop everything
        await db.dropDatabase()

        // restore reserved users
        if (users.length)
            await db.collection('user').insertMany( users )

        // initialize internal data
        await db.collection('meta').insertOne({
            _id: 'config',
            apply: false,
            register: false,
            login: false
        })

        await db.collection('meta').insertOne({
            _id: 'invitation',
            template: '<p>Email template. {school}</p>',
            port: 465
        })

        await db.collection('meta').insertOne({
            _id: 'application',
            disclaimer: '<p>特别声明html</p>',
            tests: []
        })

        await db.collection('session').insertOne({
            _id:  '_leader',
            name: '参会领队',
            type: null,
            dual: false,
            reserved: true,
            price: 0
        })

        ctx.status = 200
        ctx.body = {}
    }
)

module.exports = {
    routes: route.routes()
}
