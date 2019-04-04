const Router = require('koa-router')
const route = new Router()
const { AccessFilter, TokenParser } = require('./auth')
const getPayload = require('./lib/get-payload')
const { Sessions } = require('./session')
const { toId, newId } = require('../lib/id-util')
const { LogOp } = require('../lib/logger')
const { filterExchange } = require('./exchange')
const { relinquishQuota, exchangeQuota, setLeaderAttend, syncSeatToQuota } = require('./ng-quota')

const IsSchoolSelfOr = (...requiredAccesses) => async (ctx, next) => {
    if ( !ctx.token && await TokenParser(ctx)) {
        if (
            (ctx.hasAccessTo('leader') || ctx.hasAccessTo('individual'))
            && ctx.params.id === ctx.token.school
        )
            return await next()
        else
            return await AccessFilter(...requiredAccesses)(ctx, next)
    }
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

function findIndividualSession(seat) {
    for (let key in seat)
        if (seat[key] > 0)
            return key
}

// return a aggregation projection field decl
function sumMapRepr(mapper) {
    return { $sum: { $map: { input: '$representatives', as: 'repr', in: mapper }} }
}

route.get('/schools/',
    AccessFilter('leader', 'individual', 'staff', 'finance'),
    async ctx => {
        let filter = {}
        if (ctx.query.stage) {
            filter.stage = { $eq: ctx.query.stage }
        }

        let lookup = []

        let projection = {
            _id:   0,
            id:    '$_id',
            type:  { $ifNull: ['$type', 'school'] },
            name:  { $ifNull: ['$identifier', '$school.name'] },
            administrative_area: '$school.administrative_area',
            stage: '$stage'
        }

        if (ctx.query.seat) {
            projection.seat = '$seat'
        }

        if (ctx.query.representative_status) {
            lookup.push({
                from: 'representative',
                localField: '_id',
                foreignField: 'school',
                as: 'representatives'
            })
            projection = {
                ... projection,
                attending_representatives: sumMapRepr({$cond: ['$$repr.withdraw', 0, 1]}),
                withdrawn_representatives: sumMapRepr({$cond: ['$$repr.withdraw', 1, 0]}),
                disclaimer_approved_representatives: sumMapRepr({$cond: [
                    { $and: [
                        { $ne: ['$$repr.withdraw', true] },
                        { $eq: ['$$repr.disclaimer_approval', true] }
                    ]}, 1, 0
                ]}),
                disclaimer_rejected_representatives: sumMapRepr({$cond: [
                    { $and: [
                        { $ne: ['$$repr.withdraw', true] },
                        { $eq: ['$$repr.disclaimer_approval', false] }
                    ]}, 1, 0
                ]})
            }
        }

        ctx.status = 200
        ctx.body = await ctx.db.collection('school').aggregate([
            { $match: filter },
            ... lookup.map(decl => ({ $lookup: decl })),
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
        ctx.body = {
            type: 'school',
            identifier: ctx.school.school.name,
            ...toId(ctx.school)
        }
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

        const payload = getPayload(ctx)

        if ( field.startsWith('seat.') ) {
            let stage = ctx.school.stage
            const currentRoundPaid = field[5] === stage[0] && stage.endsWith('.paid')
            if (currentRoundPaid) {
                ctx.status = 412
                ctx.body = { error: 'incorrect stage to modify seats' }
                return
            }

            let updateSetArgs = {}
            if (typeof payload === 'object') {
                // merge seat fields, otherwise leader attendance seat will be overwritten
                for (let key in payload)
                    updateSetArgs[`${field}.${key}`] = payload[key]
            } else {
                updateSetArgs = payload
            }

            let {
                matchedCount
            } = await ctx.db.collection('school').updateOne(
                { _id: ctx.school._id },
                { $set: updateSetArgs }
            )
            if (matchedCount === 0) {
                ctx.status = 412
                ctx.body = { error: 'invalid stage' }
                return
            }
            await syncSeatToQuota(ctx, ctx.school._id)
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
                ctx.status = 409
                ctx.body = { error: 'insufficient seats' }
                return
            }

            await relinquishQuota(ctx, ctx.school._id, session)

            processed = true
        }

        // leaderAttend
        if (leaderAttend !== undefined) {
            if (Number(ctx.school.stage) >= 3) {
                ctx.status = 400
                ctx.body = { error: 'invalid stage' }
                return
            }
            const updateQuery = leaderAttend
                ? { $set: { 'seat.1._leader_r': 1 },
                    $unset: { 'seat.1._leader_nr': '' } }
                : { $set: { 'seat.1._leader_nr': 1 },
                    $unset: { 'seat.1._leader_r': '' } }
            const {
                matchedCount,
                modifiedCount
            } = await ctx.db.collection('school').updateOne(
                { _id: ctx.school._id },
                updateQuery
            )
            await setLeaderAttend(ctx, ctx.school._id, leaderAttend)
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
                ctx.status = 409
                ctx.body = { error: 'dual session must have dual seats' }
                return
            }
            await ctx.db.collection('school').updateOne(
                { _id: ctx.school._id },
                { $set: { stage: '1.reservation' } }
            )
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

        // check for roomshares, if present, refuse to nuke
        const roomshares = await ctx.db.collection('reservation').find({ school: id, 'roomshare.state': 'accepted' }).toArray()
        if (roomshares.length > 0) {
            ctx.status = 412
            ctx.body = {
                error: 'school has accepted roomshares',
                cause: 'roomshare',
                roomshareWith: roomshares.map($ => $.roomshare.school)
            }
            return
        }

        await ctx.db.collection('school').updateOne(
            { _id: { $eq: id } },
            { $set: { stage: 'x.nuking' } }
        )

        // NOTE: payment, billing information are not removed
        await ctx.db.collection('exchange').deleteMany({ 'from.school': { $eq: id } })
        await ctx.db.collection('exchange').deleteMany({ 'to.school': { $eq: id } })
        await ctx.db.collection('invitation').deleteMany({ school: { $eq: id } })
        await ctx.db.collection('representative').deleteMany({ school: { $eq: id } })
        await ctx.db.collection('user').deleteMany({ school: {$eq: id}, reserved: {$ne: true} })
        await ctx.db.collection('application').deleteMany({ _id: { $eq: id } })    // application and school share same id

        // flag accepted roomshares, should notify roomshare initiators
        await ctx.db.collection('reservation').updateMany(
            { 'roomshare.school': id },
            { $set: { 'roomshare.state': 'peer-withdraw' } }
        )

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
            confirmSecondRound,
            confirmPayment,
            startConfirm
        } = getPayload(ctx)

        if (confirmReservation) {
            const reservations = await ctx.db.collection('reservation').find({ school: ctx.params.id }).toArray()
            const roomshares = await ctx.db.collection('reservation').find({ 'roomshare.school': ctx.params.id }).toArray()
            // all roomshare must be null or accepted
            const reservationsResolved = reservations.every(({roomshare}) =>
                roomshare === null || roomshare.state === 'accepted' || roomshare.state === 'peer-withdraw'
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
            if (!ctx.hasAccessTo('staff')) {
                ctx.status = 403
                ctx.body = { error: 'forbidden' }
                return
            }
            const school = await ctx.db.collection('school').findOne(
                { _id: ctx.school._id },
                { 'seat.2pre': true, stage: true }
            )
            if (!school.seat['2pre']) {
                ctx.status = 409
                ctx.body = { error: 'no second round alloc' }
                return
            }
            if (   school.stage !== '2.reservation'
                && school.stage !== '2.payment'
                && school.stage !== '2.complete'
                && school.stage !== '1.complete'
            ) {
                ctx.status = 409
                ctx.body = { error: 'conflict', message: 'invalid stage to progress second round' }
                return
            }
            await ctx.db.collection('school').updateOne(
                { _id: ctx.school._id },
                { $set: { stage: '2.reservation', 'seat.2': school.seat['2pre'] } }
            )
            // active second round payment record
            await ctx.db.collection('payment').updateOne(
                { school: ctx.school._id, active: false, round: '2' },
                { $set: { active: true } }
            )
            ctx.status = 200
            ctx.body = { ok: 1 }
        }

        if (confirmPayment) {
            // update stage -> paid
            let nextStage = ctx.school.stage.replace('.payment', '.paid')
            if ( nextStage !== ctx.school.stage ) {
                await ctx.db.collection('school').updateOne(
                    { _id: ctx.params.id, stage: ctx.school.stage },
                    { $set: { stage: nextStage } }
                )
            } else {
                ctx.status = 412
                ctx.body = { error: 'incorrect school stage' }
                return
            }
            ctx.status = 200
            ctx.body = {
                message: 'ok',
                nextStage
            }
        }

        if (startConfirm) {
            // only staff can start confirmation process
            if (!ctx.hasAccessTo('staff')) {
                ctx.status = 403
                ctx.body = { error: 'forbidden' }
                return
            }
            if (ctx.school.stage !== '1.complete' && ctx.school.stage !== '2.complete') {
                ctx.status = 409
                ctx.body = { error: 'invalid stage' }
                return
            }
            if (ctx.school.type === 'school') {
                await ctx.db.collection('school').updateOne(
                    { _id: ctx.school._id },
                    { $set: { stage: '3.confirm' } }
                )
                // insert representatives
                let leaderAttend = ctx.school.seat['1']['_leader_r'] >= 1 || !ctx.school.seat['1']['_leader_nr']
                for (let round of ['1', '2'])
                    for (let session in (ctx.school.seat[round] || {}))
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
                                    is_leader: leaderAttend ? false
                                             : session==='_leader_nr' ? true
                                             : null,
                                    withdraw: false,
                                })
                            }
                        }
                ctx.status = 200
                ctx.body = { message: 'ok', nextStage: '3.confirm' }
                return
            }
            if (ctx.school.type === 'individual') {
                const representative = ctx.school.representative
                const nextStage = representative.confirmed ? '9.complete' : '3.confirm'
                await ctx.db.collection('school').updateOne(
                    { _id: ctx.school._id },
                    { $set: { stage: nextStage } }
                )
                // insert representative
                await ctx.db.collection('representative').insertOne({
                    _id: newId(),
                    school: ctx.school._id,
                    session: findIndividualSession(ctx.school.seat['1']),
                    round: '1',
                    created: new Date(),
                    is_leader: null,
                    withdraw: false,
                    ...representative
                })
                ctx.status = 200
                ctx.body = { message: 'ok', nextStage }
                return
            }
            ctx.status = 500
            ctx.body = { error: 'unknown school type' }
        }
    }
)

route.get('/schools/name/:name',
    async ctx => {
        const school = await ctx.db.collection('school').findOne(
            { 'school.name': ctx.params.name },
            { contact: true }
        )
        if (school) {
            ctx.status = 200
            ctx.body = toId(school)
        } else {
            ctx.status = 200
            ctx.body = null
        }
    }
)

async function ReturnIndividualInfo(ctx) {
    if (ctx.school.type !== 'individual') {
        ctx.status = 404
        ctx.body = { error: 'not found' }
        return
    }

    if (ctx.school.stage[0] === '3' || ctx.school.stage[0] === '9') {
        const representative = toId(await ctx.db.collection('representative').findOne({ school: ctx.school._id }))
        ctx.status = 200
        ctx.body = {
            ...representative,
            confirmed: ctx.school.stage[0] === '9',
        }
    } else {
        const {
            seat,
            representative
        } = await ctx.db.collection('school').findOne({ _id: ctx.school._id })
        ctx.status = 200
        ctx.body = {
            ...representative,
            session: findIndividualSession(seat['1'])
        }
    }
}

route.get('/schools/:id/individual',
    IsSchoolSelfOr('admin'),
    School,
    ReturnIndividualInfo
)

route.patch('/schools/:id/individual',
    IsSchoolSelfOr('admin'),
    School,
    async ctx => {
        if (ctx.school.type !== 'individual') {
            ctx.status = 404
            ctx.body = { error: 'not found' }
            return
        }

        let payload = getPayload(ctx)
        delete payload.school
        delete payload.round
        delete payload.session
        delete payload.confirmed
        delete payload.contact
        delete payload.withdraw
        delete payload.disclaimer_approval
        delete payload.disclaimer_approval_note

        if (ctx.school.stage[0] === '3' || ctx.school.stage[0] === '9') {
            await ctx.db.collection('representative').updateOne(
                { school: ctx.school._id },
                { $set: payload }
            )
            await ReturnIndividualInfo(ctx)
        } else {
            let updateSet = {}
            for (let key in payload)
                updateSet[`representative.${key}`] = payload[key]
            await ctx.db.collection('school').updateOne(
                { _id: ctx.school._id },
                { $set: updateSet }
            )
            await ReturnIndividualInfo(ctx)
        }
    }
)

route.post('/schools/:id/individual',
    IsSchoolSelfOr('admin'),
    School,
    async ctx => {
        if (ctx.school.type !== 'individual') {
            ctx.status = 404
            ctx.body = { error: 'not found' }
            return
        }

        const {
            confirm
        } = getPayload(ctx)

        if (confirm) {
            if (ctx.school.representative.confirmed || ctx.school.stage[0] === '9') {
                ctx.status = 409
                ctx.body = { error: 'already confirmed' }
                return
            }

            if (ctx.school.stage[0] === '3') {
                // individual confirms after representative entry creation
                await ctx.db.collection('school').updateOne(
                    { _id: ctx.school._id },
                    { $set: { stage: '9.complete' } }
                )
                await School(ctx)
            } else {
                await ctx.db.collection('school').updateOne(
                    { _id: ctx.school._id },
                    { $set: { 'representative.confirmed': true } }
                )
            }

            await ReturnIndividualInfo(ctx)
            return
        }

        ctx.status = 400
        ctx.body = { error: 'no action' }
    }
)

module.exports = {
    routes: route.routes(),
    IsSchoolSelfOr,
    School,
}
