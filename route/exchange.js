const Router = require('koa-router')
const route = new Router()
const { AccessFilter } = require('./auth')
const { toId, newId } = require('../lib/id-util')
const { exchangeQuota } = require('./ng-quota')
const { writeSchoolOpLog } = require('./op-log')
const { Sessions } = require('./session')

// either from or to should be school itself
async function hasAccess(ctx, from, to) {
    let {
        school
    } = ctx.token

    if ( ctx.hasAccessTo('staff') )
        return true

    if ( ctx.hasAccessTo('leader') )
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
    if (state !== undefined)
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
    AccessFilter('leader', 'staff'),
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
    AccessFilter('leader'),
    Sessions,
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
            identifier: 1,
            school: 1,
            seat: 1
        })

        let selfInExchange = await ctx.db.collection('exchange').count({
            'from.school': schoolId,
            'from.session': selfSession,
            state: false
        }, {
            _id: 1,
            school: 1,
            seat: 1
        })

        if ( ! (from && to && selfInExchange < from.seat['1'][selfSession]) ) {
            ctx.status = 409
            ctx.body = { error: 'all seats in exchange, can not overbid.' }
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

        const {
            insertedId
        } = await ctx.db.collection('exchange').insertOne(exchange)

        // generate op-log
        const initiatingSessionName = ctx.sessions.find(s => s._id === selfSession).name
        const targetSessionName = ctx.sessions.find(s => s._id === targetSession).name
        const targetSchoolIdentifier = to.identifier || to.school.name
        await writeSchoolOpLog(ctx, from._id, 'exchange', `发起名额交换：用「${initiatingSessionName}」交换「${targetSchoolIdentifier}」的「${targetSessionName}」 (${insertedId})`)

        ctx.status = 200
        ctx.body = toId(exchange)
    }
)

route.post('/exchanges/:id',
    AccessFilter('leader'),
    Exchange,
    Sessions,
    async ctx => {
        let {
            accept,
            refuse,
            cancel
        } = ctx.request.body

        let {
            from: { school: fromSchool, session: fromSession },
            to: { school: toSchool, session: toSession },
            _id
        } = ctx.exchange

        if (!accept && !refuse && !cancel) {
            ctx.status = 400
            ctx.body = { error: 'bad request' }
            return
        }

        if (
             ((accept || refuse) && ctx.token.school !== toSchool)
          || (cancel && ctx.token.school !== fromSchool)
         ) {
            ctx.status = 403
            ctx.body = { error: 'forbidden' }
            return
        }

        if ( ctx.exchange.state ) {
            ctx.status = 409
            ctx.body = { error: 'peer processed this exchange' }
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

            await exchangeQuota(
                ctx,
                { school: fromSchool, session: fromSession },
                { school: toSchool, session: toSession }
            )

            if ( from.seat['1'][fromSession] < 1 || to.seat['1'][toSession] < 1 ) {
                ctx.status = 409
                ctx.body = { error: 'no seat available' }
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

            // check if from/to's from/to session reaches 0
            from = await ctx.db.collection('school').findOne({ _id: fromSchool })
            to = await ctx.db.collection('school').findOne({ _id: toSchool })
            if (from.seat['1'][fromSession] === 0)
                await removeUnavailable(ctx, fromSchool, fromSession)
            if (to.seat['1'][toSession] === 0)
                await removeUnavailable(ctx, toSchool, toSession)

            let {
                seat: currentSeat
            } = await ctx.db.collection('school').findOne(
                { _id: toSchool },
                { seat: 1 }
            )

            // generate op-log
            const targetSessionName = ctx.sessions.find(s => s._id === ctx.exchange.to.session).name
            const targetSchool = await ctx.db.collection('school').findOne({ _id: ctx.exchange.to.school })
            const targetSchoolIdentifier = targetSchool.identifier || targetSchool.school.name
            const initiatingSessionName = ctx.sessions.find(s => s._id === ctx.exchange.from.session).name
            const initiatingSchool = await ctx.db.collection('school').findOne({ _id: ctx.exchange.from.school })
            const initiatingSchoolIdentifier = initiatingSchool.identifier || initiatingSchool.school.name
            await writeSchoolOpLog(ctx, ctx.exchange.from.school, 'exchange', `名额交换被接受：用「${initiatingSessionName}」交换「${targetSchoolIdentifier}」的「${targetSessionName}」 (${ctx.exchange._id})`)
            await writeSchoolOpLog(ctx, ctx.exchange.to.school, 'exchange', `接受名额交换：「${initiatingSchoolIdentifier}」用「${initiatingSessionName}」交换「${targetSessionName}」 (${ctx.exchange._id})`)

            ctx.status = 200
            ctx.body = currentSeat
            return
        }

        if ( cancel ) {
            ctx.log.op = 'cancel'
            await ctx.db.collection('exchange').updateOne(
                { _id },
                { $set: { state: 'cancelled' } }
            )

            let {
                seat: currentSeat
            } = await ctx.db.collection('school').findOne(
                { _id: fromSchool },
                { seat: 1 }
            )

            // generate op-log
            const initiatingSessionName = ctx.sessions.find(s => s._id === ctx.exchange.from.session).name
            const targetSessionName = ctx.sessions.find(s => s._id === ctx.exchange.to.session).name
            const targetSchool = await ctx.db.collection('school').findOne({ _id: ctx.exchange.to.school })
            const targetSchoolIdentifier = targetSchool.identifier || targetSchool.school.name
            await writeSchoolOpLog(ctx, ctx.exchange.from.school, 'exchange', `取消名额交换：用「${initiatingSessionName}」交换「${targetSchoolIdentifier}」的「${targetSessionName}」 (${ctx.exchange._id})`)

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
