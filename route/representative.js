const Router = require('koa-router')
const route = new Router()
const { AccessFilter } = require('./auth')
const { IsSchoolSelfOr, School } = require('./school')
const getPayload = require('./lib/get-payload')
const { LogOp } = require('../lib/logger')
const { toId, newId } = require('../lib/id-util')

const AGGREGATE_REPRESENTATIVES = [
    { $lookup: {
        localField: 'school',
        foreignField: '_id',
        from: 'school',
        as: 'school',
    } },
    { $lookup: {
        localField: 'session',
        foreignField: '_id',
        from: 'session',
        as: 'session',
    } },
    { $sort: { 'school.school.name': 1 } },
    { $unwind: '$school' },
    { $unwind: '$session' }
]

const AGGREGATE_OPTS = {
    collation: {
        locale: 'zh'
    }
}

const makeRepresentativeEntry = (representative, session, school) => {
    return {
        id: representative._id,
        round: representative.round || '1',
        contact: representative.contact,
        graduation_year: representative.graduation_year,
        identification: representative.identification,
        guardian: representative.guardian,
        guardian_identification: representative.guardian_identification,
        is_leader: representative.is_leader,
        withdraw: representative.withdraw,
        note: representative.note,
        session: {
            id: session._id,
            name: session.name
        },
        school: {
            id: school._id,
            name: school.school.name
        }
    }
}

route.get('/schools/:id/representatives/',
    IsSchoolSelfOr('staff', 'finance'),
    async ctx => {
        ctx.status = 200
        ctx.body = await ctx.db.collection('representative').aggregate([
            { $match: { school: ctx.params.id } },
            { $lookup: {
                from: 'session',
                localField: 'session',
                foreignField: '_id',
                as: 'session'
            }},
            { $lookup: {
                from: 'school',
                localField: 'school',
                foreignField: '_id',
                as: 'school'
            } },
            { $unwind: '$session' },
            { $unwind: '$school' },
            { $project: {
                _id: false,
                id: '$_id',
                name: '$contact.name',
                round: { $ifNull: ['$round', '1'] },
                is_leader: '$is_leader',
                withdraw: '$withdraw',
                session: {
                    id: '$session._id',
                    name: '$session.name',
                },
                school: {
                    id: '$school._id',
                    name: '$school.school.name'
                }
            } }
        ]).toArray()
    }
)

route.get('/schools/:id/representatives/:rid',
    IsSchoolSelfOr('staff', 'finance'),
    async ctx => {
        let representative = await ctx.db.collection('representative').findOne({ _id: ctx.params.rid, school: ctx.params.id })
        if (representative) {
            let session = await ctx.db.collection('session').findOne({ _id: representative.session })
            let school = await ctx.db.collection('school').findOne({ _id: representative.school })

            ctx.status = 200
            ctx.body = makeRepresentativeEntry(representative, session, school)
        } else {
            ctx.status = 404
            ctx.body = { error: 'not found' }
        }
    }
)

route.patch('/schools/:id/representatives/:rid',
    IsSchoolSelfOr('staff', 'finance'),
    LogOp('representative', 'update'),
    async ctx => {
        let payload = getPayload(ctx)
        // certain fields are not updatable
        delete payload.id
        delete payload._id
        delete payload.school
        delete payload.round
        // certain fields can only be updated by admin
        if ( ! ctx.hasAccessTo('staff.representative') ) {
            delete payload.session
            delete payload.withdraw
        }
        let {
            matchedCount
        } = await ctx.db.collection('representative').updateOne(
            { _id: ctx.params.rid, school: ctx.params.id },
            { $set: payload }
        )

        if (matchedCount > 0) {
            ctx.status = 200
            let representative = await ctx.db.collection('representative').findOne({ _id: ctx.params.rid, school: ctx.params.id })
            if (representative) {
                let session = await ctx.db.collection('session').findOne({ _id: representative.session })
                let school = await ctx.db.collection('school').findOne({ _id: representative.school })
                ctx.body = makeRepresentativeEntry(representative, session, school)
            } else {
                ctx.body = null
            }
        } else {
            ctx.status = 404
            ctx.body = { error: 'not found' }
        }
    }
)

route.get('/representatives/',
    AccessFilter('dais', 'admin', 'finance'),
    async ctx => {
        // if dais, must own session
        const { session } = ctx.query
        const ownedSession = ctx.token.session

        if (
            ctx.hasAccessTo('dais')
            && !ctx.hasAccessTo('finance')
            && !ctx.hasAccessTo('admin')
            && session !== ownedSession
        ) {
            ctx.status = 403
            ctx.body = { error: 'unauthorized' }
            return
        }

        const query = [
            { $match: session ? { session: session } : {} },
            ... AGGREGATE_REPRESENTATIVES
        ]

        ctx.status = 200
        ctx.body = (await ctx.db.collection('representative').aggregate(query, AGGREGATE_OPTS).toArray())
            .map($ => Object.assign(
                toId($),
                { school: toId($.school), session: toId($.session) }
            ))
    }
)

route.patch('/representatives/:rid',
    AccessFilter('dais', 'admin', 'finance'),
    async ctx => {
        const representative = await ctx.db.collection('representatives')
        // if dais, must own session
        const isDais = ctx.hasAccessTo('dais') && !ctx.hasAccessTo('finance') && !ctx.hasAccessTo('admin')
        const extraMatch = isDais ? { session: ctx.token.session } : {}

        // check at least one modifiable field is provided
        const { note } = getPayload(ctx)
        if (!note) {
            ctx.status = 400
            ctx.body = { error: 'bad request' }
            return
        }

        let updatePayload = {}
        if (note !== undefined) updatePayload.note = note

        const {
            matchedCount,
            modifiedCount
        } = await ctx.db.collection('representative').updateOne(
            Object.assign({_id: ctx.params.rid}, extraMatch),
            { $set: updatePayload }
        )

        if (matchedCount === 0) {
            ctx.status = 404
            ctx.body = { error: 'not found' }
        } else {
            const representative = await ctx.db.collection('representative').findOne({ _id: ctx.params.rid })
            const session = await ctx.db.collection('session').findOne({ _id: representative.session })
            const school = await ctx.db.collection('school').findOne({ _id: representative.school })
            ctx.status = 200
            ctx.body = Object.assign(
                toId(representative),
                { school: toId(school), session: toId(session) }
            )
        }
    }
)

module.exports = {
    routes: route.routes()
}
