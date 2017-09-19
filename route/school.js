const Router = require('koa-router')
const route = new Router()
const { AccessFilter, TokenParser } = require('./auth')
const getPayload = require('./lib/get-payload')
const { Sessions } = require('./session')
const { Config } = require('./config')
const { toId, newId } = require('../lib/id-util')
const { LogOp } = require('../lib/logger')
const { filterExchange } = require('./exchange')
const escapeForRegexp = require('escape-string-regexp')
const curry = require('curry')

const IsSchoolSelfOr = (...requiredAccesses) => async (ctx, next) => {
    if ( ! ctx.token )
        await TokenParser(ctx)
    
    if ( ctx.token.access.includes('leader') && ctx.params.id === ctx.token.school )
        return await next()
    else
        return await AccessFilter(...requiredAccesses)(ctx, next)
}

async function School(ctx, next) {
    ctx.school = await ctx.db.collection('school').findOne({ _id: ctx.params.id })
    if ( ! ctx.school ) {
        ctx.status = 404
        ctx.body = { error: 'not found' }
    } else {
        if (next)
            await next()
    }
}

route.get('/schools/',
    AccessFilter('leader', 'staff', 'finance'),
    async ctx => {
        let filter = {}
        if (ctx.query.stage)
            filter.stage = { $eq: ctx.query.stage }

        let projection = {
            _id:   0,
            id:    '$_id',
            name:  '$school.name',
            stage: '$stage'
        }
        if (ctx.query.seat)
            projection.seat = '$seat'

        ctx.status = 200
        ctx.body = await ctx.db.collection('school').aggregate([
            { $match: filter },
            { $project: projection }
        ]).toArray()
    }
)

route.get('/schools/:id',
    IsSchoolSelfOr('staff', 'finance', 'admin'),
    School,
    async ctx => {
        // add 'exchanges' field
        // return school's ongoing exchange requests
        if ( ctx.school.stage === '1.exchange' ) {
            ctx.school.exchanges = ( await filterExchange(ctx, { from: ctx.school._id }) ).map( toId )
        }

        ctx.status = 200
        ctx.body = toId(ctx.school)
    }
)

route.get('/schools/:id/seat',
    IsSchoolSelfOr('staff', 'finance', 'admin'),
    School,
    async ctx => {
        ctx.status = 200
        ctx.body = ctx.school.seat
    }
)

route.patch('/schools/:id',
    AccessFilter('staff', 'finance', 'admin'),
    School,
    LogOp('school', 'patch'),
    async ctx => {
        const field = ctx.query.field
        if (   !field
            || field[0]==='$'
            || field==='stage'
            || field==='created'
            || field==='id'
            || field==='_id'
        ) {
            ctx.status = 400
            ctx.body = { error: 'bad request' }
            return
        }

        if ( field.startsWith('seat.') ) {
            let stage = ctx.school.stage
            if ( field[5] === stage[0]    // modifies current round
                 && (stage.endsWith('.paid') || stage.endsWith('.complete'))
            ) {
                ctx.status = 412
                ctx.body = { error: 'incorrect stage to make modify seats' }
                return
            }
            let {
                matchedCount
            } = await ctx.db.collection('school').updateOne(
                { _id: ctx.school._id },
                { $set: { [field]: ctx.request.body } }
            )
            if (matchedCount === 0) {
                ctx.status = 412
                ctx.body = { error: 'invalid stage' }
                return
            }
        } else {
            await ctx.db.collection('school').updateOne(
                { _id: ctx.school._id },
                { $set: { [field]: ctx.request.body } }
            )
        }

        await School(ctx)
        ctx.status = 200
        ctx.body = ctx.school
    }
)

route.post('/schools/:id/seat',
    IsSchoolSelfOr('staff'),
    LogOp('school', 'seat'),
    School,
    Sessions,
    async ctx => {
        const {
            confirmRelinquish,
            confirmExchange,
            confirmPayment,
            allocSecondRound,
            leaderAttend,
            startConfirm,
            confirmAttend,
            session,
            round,
            amount = 0,
        } = getPayload(ctx)

        let processed = false

        // seat relinquish
        if (session && round && amount) {
            let filter = { _id: ctx.school._id }
            let field = `seat.${round}.${session}`

            if (amount < 0)
                filter[field] = { $gte: -amount }

            let {
                matchedCount
            } = await ctx.db.collection('school').updateOne(
                filter,
                { $inc: { [field]: amount } }
            )

            if ( ! matchedCount ) {
                ctx.status = 410
                ctx.body = { error: 'insufficient seats' }
                return
            }

            processed = true
        }

        // leaderAttend
        if (leaderAttend !== undefined) {
            if (Number(ctx.school.stage) >= 3) {
                ctx.status = 400
                ctx.body = { error: 'invalid stage' }
                return
            }
            if (leaderAttend) {
                await ctx.db.collection('school').updateOne(
                    { _id: ctx.school._id },
                    { $set: { 'seat.1._leader_r': 1 },
                      $unset: { 'seat.1._leader_nr': '' } }
                )
            } else {
                await ctx.db.collection('school').updateOne(
                    { _id: ctx.school._id },
                    { $set: { 'seat.1._leader_nr': 1 },
                      $unset: { 'seat.1._leader_r': '' } }
                )
            }
            processed = true
        }

        // confirmRelinquish
        if (confirmRelinquish) {
            let {
                matchedCount
            } = await ctx.db.collection('school').updateOne(
                { _id: ctx.school._id, stage: '1.relinquishment' },
                { $set: { stage: '1.exchange' } }
            )
            processed = matchedCount === 1
        }

        // confirmExchange
        if (confirmExchange) {
            if (ctx.school.stage !== '1.exchange') {
                ctx.status = 412
                ctx.body = { error: 'bad stage to confirm exchange' }
            }
            // revoke all pending requests
            await ctx.db.collection('exchange').updateMany(
                { 'from.school': ctx.school._id, state: false },
                { $set: { state: 'gone' } }
            )
            await ctx.db.collection('exchange').updateMany(
                { 'to.school': ctx.school._id, state: false },
                { $set: { state: 'gone' } }
            )
            // verify dual representative seats
            await School(ctx)    // refresh ctx.school, ensures we have latest seat information
            let seat = ctx.school.seat['1']
            // NOTE: admin can bypass dual session requirement
            let dualSessionHasDualSeats = (
                  ctx.hasAccessTo('staff')
                ? true
                : ctx.sessions.filter( $ => $.dual )
                              .every( $ => (ctx.school.seat['1'][$._id] || 0) % 2 === 0 )
            )
            if ( ! dualSessionHasDualSeats ) {
                ctx.status = 410
                ctx.body = { error: 'dual session must have dual seats' }
                return
            }
            await ctx.db.collection('school').updateOne(
                { _id: ctx.school._id },
                { $set: { stage: '1.reservation' } }
            )
            processed = true
        }

        // startConfirm
        if (startConfirm) {
            if ( ! await AccessFilter('admin')(ctx) )
                return
            let {
                matchedCount
            } = await ctx.db.collection('school').updateOne(
                { _id: ctx.school._id, stage: { $in: ['1.complete', '2.complete'] } },
                { $set: { stage: '3.confirm' } }
            )
            if (matchedCount !== 1) {
                ctx.status = 404
                ctx.body = { error: 'not found' }
                return
            }
            // insert representatives
            let leaderAttend = ctx.school.seat['1']['_leader_r'] >= 1 || !ctx.school.seat['1']['_leader_nr']
            for (let round in ctx.school.seat)
                for (let session in ctx.school.seat[round])
                    for (let i=0; i!==ctx.school.seat[round][session]; ++i) {
                        if (session !== '_leader_r') {
                            // is_leader: representative is leader
                            // if !leaderAttend (leader is not representative) -> infer leader from _leader_nr session
                            // if leaderAttend -> ask user to select leader
                            ctx.db.collection('representative').insertOne({
                                _id: newId(),
                                school: ctx.school._id,
                                session,
                                round,
                                created: new Date(),
                                is_leader: leaderAttend ? false : (session==='_leader_nr' ? true: null),
                                withdraw: false,
                            })
                        }
                    }
            processed = true
        }

        if (confirmAttend) {
            let {
                matchedCount
            } = await ctx.db.collection('school').updateOne(
                { _id: ctx.school._id, stage: '3.confirm' },
                { $set: { stage: '9.complete' } }
            )
            if (matchedCount !== 1) {
                ctx.status = 412
                ctx.body = { error: 'invalid stage to confirm attendance' }
                return
            }
            processed = true
        }

        if (processed) {
            ctx.status = 200
            ctx.body = (await ctx.db.collection('school').findOne(
                { _id: ctx.school._id },
                { _id: 0, seat: 1 }
            )).seat
        } else {
            ctx.status = 400
            ctx.body = { error: 'bad request' }
        }
    }
)

route.delete('/schools/:id',
    AccessFilter('staff.nuke'),
    School,
    LogOp('school', 'nuke'),
    async ctx => {
        let id = ctx.school._id
        await ctx.db.collection('school').updateOne(
            { _id: { $eq: id } },
            { $set: { stage: 'x.nuking' } }
        )

        // NOTE: payment, billing information are not removed
        await ctx.db.collection('exchange').deleteMany({ 'from.school': { $eq: id } })
        await ctx.db.collection('exchange').deleteMany({ 'to.school': { $eq: id } })
        await ctx.db.collection('invitation').deleteMany({ school: { $eq: id } })
        await ctx.db.collection('representative').deleteMany({ school: { $eq: id } })

        // restore reservations
        let reservations = await ctx.db.collection('reservation').find({ school: { $eq: id } }).toArray()
        await ctx.db.collection('reservation').deleteMany({ school: { $eq: id } })
        await Promise.all( reservations.map( $ => ctx.db.collection('hotel').updateOne(
            { _id: $.hotel },
            { $inc: { available: 1 } }
        ) ) )

        await ctx.db.collection('school').deleteOne({ _id: { $eq: id } })

        ctx.status = 200
        ctx.body = { message: 'nuked' }
    }
)

route.post('/schools/:id/progress',
    IsSchoolSelfOr('staff', 'finance', 'admin'),
    School,
    async ctx => {
        const {
            confirmReservation,
            confirmSecondRound
        } = getPayload(ctx)

        if (confirmReservation) {
            const reservations = await ctx.db.collection('reservation').find({ school: ctx.params.id }).toArray()
            const roomshares = await ctx.db.collection('reservation').find({ 'roomshare.school': ctx.params.id }).toArray()
            // all roomshare must be null or accepted
            const reservationsResolved = reservations.every(({roomshare}) => 
                roomshare === null || roomshare.state === 'accepted'
            )
            const roomsharesResolved = roomshares.every(({roomshare: {state}}) =>
                state === 'accepted' || state === 'rejected'
            )
            if (reservationsResolved && roomsharesResolved) {
                const {
                    modifiedCount
                } = await ctx.db.collection('school').updateOne(
                    { _id: ctx.params.id, stage: ctx.school.stage[0]+'.reservation' },
                    { $set: { stage: ctx.school.stage.replace('.reservation', '.payment')} }
                )           
                ctx.status = 200
                ctx.body = { message: 'ok' }
            } else {
                ctx.status = 409
                ctx.body = { error: 'conflict', message: 'must resolve all roomshares before proceed' }
            }
        }

        if (confirmSecondRound) {
            // only admin can allocate second round seats
            if (ctx.hasAccessTo('staff')) {
                let {
                    matchedCount
                } = await ctx.db.collection('school').updateOne(
                    { _id: ctx.school._id, stage: '1.complete' },
                    { $set: { stage: '2.reservation' } }
                )
                if (matchedCount === 1) {
                    ctx.status = 200
                    ctx.body = { ok: 1 }
                } else {
                    ctx.status = 409
                    ctx.body = { error: 'conflict', message: 'invalid stage to progress second round' }
                }
            } else {
                ctx.status = 403
                ctx.body = { error: 'forbidden' }
            }
        }
    }
)

module.exports = {
    routes: route.routes(),
    IsSchoolSelfOr,
    School,
}
