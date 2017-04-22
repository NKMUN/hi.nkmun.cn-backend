const Router = require('koa-router')
const route = new Router()
const { AccessFilter, TokenParser } = require('./auth')
const getPayload = require('./lib/get-payload')
const { Config } = require('./config')
const { toId, newId } = require('../lib/id-util')
const { LogOp } = require('../lib/logger')

// either from or to should be school itself
async function hasAccess(ctx, from, to) {
    let {
        school,
        access
    } = ctx.token

    if ( access.indexOf('admin') !== -1 )
        return true

    if ( access.indexOf('school') !== -1 )
        return school === from || school === to

    return false
}

async function filterExchange(ctx, {
    from = null,
    to = null,
    state = null
} = {}) {
    let filter = {}
    if (from !== undefined && from !== null)
        filter['from.school'] = { $eq: from }
    if (to !== undefined && to !== null)
        filter['to.school'] = { $eq: to }
    if (state !== undefined && to !== null)
        filter['state'] = { $eq: state }
    return await ctx.db.collection('exchange').aggregate([
        { $match: filter }
    ]).toArray()
}

async function Exchange(ctx, next) {
    ctx.exchange = await ctx.db.collection('exchange').findOne({ _id: ctx.params.id })
    if ( ! ctx.exchange ) {
        ctx.status = 404
        ctx.body = { error: 'not found' }
    } else {
        await next()
    }
}

async function removeUnavailable(ctx, school, session) {
    await ctx.db.collection('exchange').updateMany(
        { state: false, 'from.schoool': school, 'from.session': session },
        { $set: { state: 'unavailable' } }
    )
    await ctx.db.collection('exchange').updateMany(
        { state: false, 'to.schoool': school, 'to.session': session },
        { $set: { state: 'unavailable' } }
    )
}

route.get('/exchanges/',
    AccessFilter( 'school', 'admin' ),
    async ctx => {
        let {
            from,
            to,
            state,
        } = ctx.query

        if (state === 'false' || state === '0')
            state = false

        if ( ! await hasAccess(ctx, from, to) ) {
            ctx.status = 403
            ctx.body = { error: 'forbidden' }
        }

        ctx.status = 200
        ctx.body = ( await filterExchange(ctx, { from, to, state }) ).map( toId )
    }
)

route.post('/exchanges/',
    AccessFilter( 'school' ),
    LogOp('exchange', 'submit'),
    async ctx => {
        let {
            token: { school: schoolId }
        } = ctx

        let {
            target,
            targetSession,
            selfSession,
            note
        } = ctx.request.body

        if ( !target || !targetSession || !selfSession ) {
            ctx.status = 400
            ctx.body = { error: 'bad request' }
            return
        }

        let from = await ctx.db.collection('school').findOne({
            _id: schoolId,
            stage: '1.exchange',
            [`seat.1.${selfSession}`]: { $gte: 1 }
        })

        let to = await ctx.db.collection('school').findOne({
            _id: target,
            stage: '1.exchange',
            [`seat.1.${targetSession}`]: { $gte: 1 }
        }, {
            _id: 1,
            school: 1,
            seat: 1
        })

        let selfInExchange = await ctx.db.collection('exchange').count({
            'from.school': schoolId,
            'from.session': selfSession
        }, {
            _id: 1,
            school: 1,
            seat: 1
        })

        if ( ! (from && to && selfInExchange<from.seat['1'][selfSession]) ) {
            ctx.status = 410
            ctx.body = { error: 'gone' }
            return
        }

        let exchange = {
            _id: newId(),
            from: {
                school: from._id,
                name: from.school.name,
                session: selfSession
            },
            to: {
                school: to._id,
                name: to.school.name,
                session: targetSession
            },
            note,
            state: false
        }

        await ctx.db.collection('exchange').insert(exchange)

        ctx.status = 200
        ctx.body = toId(exchange)
    }
)

route.post('/exchanges/:id',
    AccessFilter('school', 'admin'),
    LogOp('exchange', 'process'),
    Exchange,
    async ctx => {
        let {
            accept,
            refuse
        } = ctx.request.body

        let {
            from: { school: fromSchool, session: fromSession },
            to: { school: toSchool, session: toSession },
            _id
        } = ctx.exchange

        if ( ctx.token.school && ctx.token.school !== toSchool ) {
            ctx.status = 403
            ctx.body = { error: 'forbidden' }
            return
        }

        if ( ctx.exchange.state ) {
            ctx.status = 410
            ctx.body = { error: 'gone' }
            await ctx.db.collection('exchange').updateOne(
                { _id },
                { $set: { state: 'unavailable' } }
            )
            return
        }

        if ( refuse ) {
            ctx.log.op = 'refuse'
            await ctx.db.collection('exchange').updateOne(
                { _id },
                { $set: { state: 'refused' } }
            )

            let {
                seat: currentSeat
            } = await ctx.db.collection('school').findOne(
                { _id: toSchool },
                { seat: 1 }
            )

            ctx.status = 200
            ctx.body = currentSeat
            return
        }

        if ( accept ) {
            ctx.log.op = 'accept'
            let from = await ctx.db.collection('school').findOne({ _id: fromSchool })
            let to = await ctx.db.collection('school').findOne({ _id: toSchool })

            if ( from.seat['1'][fromSession] < 1 || to.seat['1'][toSession] < 1 ) {
                ctx.status = 410
                ctx.body = { error: 'gone' }
                await ctx.db.collection('exchange').updateOne(
                    { _id },
                    { $set: { state: 'unavailable' } }
                )
                return
            }

            await ctx.db.collection('school').updateOne(
                { _id: fromSchool },
                { $inc: {
                    [`seat.1.${fromSession}`]: -1 ,
                    [`seat.1.${toSession}`]:    1 ,
                } }
            )

            await ctx.db.collection('school').updateOne(
                { _id: toSchool },
                { $inc: {
                    [`seat.1.${toSession}`]:  -1,
                    [`seat.1.${fromSession}`]: 1 ,
                } }
            )

            await ctx.db.collection('exchange').updateOne(
                { _id },
                { $set: { state: 'accepted' } }
            )

            // check if requests to from/to's from/to session can be satisfied
            // from, to are fetched before performing exchange
            // test seat availability using 1
            if (from.seat['1'][fromSession] === 1)
                await removeUnavailable(ctx, fromSchool, fromSession)
            if (to.seat['1'][toSession] === 1)
                await removeUnavailable(ctx, toSchool, toSession)

            let {
                seat: currentSeat
            } = await ctx.db.collection('school').findOne(
                { _id: toSchool },
                { seat: 1 }
            )

            ctx.status = 200
            ctx.body = currentSeat
            return
        }

        ctx.status = 400
        ctx.body = { error: 'bad request' }
    }
)

module.exports = {
    filterExchange,
    routes: route.routes()
}
