const Router = require('koa-router')
const route = new Router()
const { AccessFilter } = require('./auth')

route.post('/initialize',
    AccessFilter('admin'),
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
            _id: 'mail',
            host: 'smtpdm.aliyun.com',
            port: 465,
            nickname: '汇文国际模拟联合国大会组委会',
            invitation: '<p>Email template. {school}</p>',

        })

        await db.collection('meta').insertOne({
            _id: 'application',
            disclaimer: '<p>特别声明html</p>',
            tests: []
        })

        await db.collection('session').insertOne({
            _id:  '_leader_nr',
            name: '非代表领队',
            type: null,
            dual: false,
            reserved: true,
            requiresChairman: false,
            exchangeable: false,
            price: 0
        })

        await db.collection('session').insertOne({
            _id:  '_leader_r',
            name: '代表兼任领队',
            type: null,
            dual: false,
            reserved: true,
            requiresChairman: false,
            exchangeable: false,
            price: 0
        })

        await db.collection('op-log').createIndex({ school: 1, workflow: 1 })

        ctx.status = 200
        ctx.body = {}
    }
)

module.exports = {
    routes: route.routes()
}
