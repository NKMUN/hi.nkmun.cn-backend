const Router = require('koa-router')
const route = new Router()
const { IsSchoolSelfOr, School } = require('./school')
const getPayload = require('./lib/get-payload')
const { LogOp } = require('../lib/logger')
const { toId, newId } = require('../lib/id-util')

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

module.exports = {
    routes: route.routes()
}
