const Router = require('koa-router')
const route = new Router()
const { AccessFilter } = require('./auth')

route.get('/schools/:id/logs',
    AccessFilter('staff', 'finance', 'admin'),
    async ctx => {
        ctx.status = 200
        ctx.body = await ctx.db.collection('op-log').aggregate([
            { $match: { school: ctx.params.id } },
            { $sort: { time: -1 } }
        ]).toArray()
    }
)

async function writeSchoolOpLog(ctx, school, workflow, text='', args={}) {
    const { user } = ctx.token
    const ip = ctx.request.ips[0]
    const user_agent = ctx.request.headers['user-agent']

    await ctx.db.collection('op-log').insertOne({
        school,
        workflow,
        text,
        args,
        time: new Date(),
        ip,
        user_agent,
        user,
    })
}

module.exports = {
    routes: route.routes(),
    writeSchoolOpLog
}