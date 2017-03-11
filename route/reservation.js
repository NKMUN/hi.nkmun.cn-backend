const Router = require('koa-router')
const route = new Router()
const { AccessFilter } = require('./auth')
const { IsSelfOrAdmin } = require('./school')
const getPayload = require('./lib/get-payload')
const { LogOp } = require('../lib/logger')
const { toId, newId } = require('../lib/id-util')

route.post('/schools/:id/reservations/',
    IsSelfOrAdmin,
    LogOp('reservation', 'reserve'),
    async ctx => {
        let reservations = getPayload(ctx)

        // verify checkIn/Out
        let valid = (
            await Promise.all(
                reservations.map( $ =>
                    ctx.db.collection('hotel').findOne({ _id: $.hotel })
                    .then( hotel =>
                        hotel
                        && $.checkIn
                        && $.checkOut
                        && new Date($.checkIn).getTime() >= new Date(hotel.notBefore).getTime()
                        && new Date($.checkOut).getTime() <= new Date(hotel.notAfter).getTime()
                    )
                )
            )
        ).every( v => v )

        if (!valid) {
            ctx.status = 400
            ctx.body = { error: 'bad request' }
            return
        }

        let restore = []
        let processed = 0
        for (; processed!==reservations.length; ++processed) {
            let $ = reservations[processed]
            let {
                modifiedCount
            } = await ctx.db.collection('hotel').updateOne(
                { _id: $.hotel, available: { $gt: 0 } },
                { $inc: { available: -1 } }
            )
            if (modifiedCount !== 1)
                break
            restore.push([ { _id: $.hotel }, { $inc: { available: 1} } ])
        }

        if (processed !== reservations.length) {
            // insufficient room
            await Promise.all( restore.map( $ => ctx.db.collection('hotel').update(...$) ) )
            ctx.status = 410
            ctx.body = { error: 'gone' }
        } else {
            // sufficient room, batch insert reservations
            let {
                insertedIds
            } = await ctx.db.collection('reservation').insertMany(
                reservations.map( $ => ({
                    _id: newId(),
                    hotel: $.hotel,
                    school: ctx.params.id,
                    checkIn: $.checkIn,
                    checkOut: $.checkOut
                }))
            )
            await ctx.db.collection('school').updateOne(
                { _id: ctx.params.id },
                { $set: { stage: '1.payment' } }
            )
            ctx.status = 200
            ctx.body = { inserted: insertedIds }
        }
    }
)

route.get('/schools/:id/reservations/',
    IsSelfOrAdmin,
    async ctx => {
        ctx.status = 200
        ctx.body = await ctx.db.collection('reservation').aggregate([
            { $match: { school: ctx.params.id } },
            { $lookup: {
                from: 'hotel',
                localField: 'hotel',
                foreignField: '_id',
                as: 'hotel'
            }},
            { $lookup: {
                from: 'school',
                localField: 'school',
                foreignField: '_id',
                as: 'school'
            } },
            { $project: {
                checkIn: '$checkIn',
                checkOut: '$checkOut',
                school: { $arrayElemAt: [ "$school", 0 ] },
                hotel: { $arrayElemAt: [ "$hotel", 0 ] }
            } },
            { $project: {
                _id: false,
                id: '$_id',
                checkIn: '$checkIn',
                checkOut: '$checkOut',
                hotel: {
                    id: '$hotel._id',
                    name: '$hotel.name',
                    type: '$hotel.type',
                    price: '$hotel.price',
                },
                school: {
                    id: '$school._id',
                    name: '$school.school.name'
                }
            } }
        ]).toArray()
    }
)

module.exports = {
    routes: route.routes()
}
